const PROPS = PropertiesService.getScriptProperties();
const WORKER_SECRET = PROPS.getProperty('WORKER_SECRET') || '';
const SLIP_FOLDER_ID = PROPS.getProperty('SLIP_FOLDER_ID') || '';
const VISION_SA_KEY = PROPS.getProperty('VISION_SA_KEY') || '';

// ====== RECEIVER ACCOUNTS CONFIG ======
const RECEIVER_ACCOUNTS = {
  '0911848961':   { code: 'KKK+', bank: 'KBank', label: 'KBank ชั้น 1' },
  '2143836889':   { code: 'MAK+', bank: 'KBank', label: 'KBank ชั้น 2 (MAK+)' },
  '5111482754':   { code: 'KGSI', bank: 'BAY',   label: 'Krungsri ชั้น 3' },
  '050711087200': { code: 'GSB5', bank: 'GSB',   label: 'GSB ชั้น 4–5' },
  '7602351442':   { code: 'TTB',  bank: 'TTB',   label: 'TTB ชั้น 4' },
  '1818203205':   { code: 'KBIZ', bank: 'KBIZ',  label: 'KBIZ' },
};
const RECEIVER_ACCOUNT_LIST = Object.keys(RECEIVER_ACCOUNTS);

// ===================================================
// doPost: route JSON actions OR OCR slip processing
// ===================================================
function doPost(e) {
  try {
    const providedSecret = getProvidedSecret_(e);
    if (WORKER_SECRET && providedSecret !== WORKER_SECRET) {
      throw new Error('Missing or invalid secret');
    }

    const pd = e && e.postData;
    const contentType = (pd && pd.type) || '';
    const contents = (pd && pd.contents) || '';

    // JSON mode only if:
    //  - content-type is JSON AND
    //  - body is non-empty
    const isJson =
      contentType.toLowerCase().indexOf('application/json') !== -1 &&
      String(contents).trim() !== '';

    // ---------- JSON mode: actions (e.g. ensureSlipFolder) ----------
    if (isJson) {
      let body = {};
      try {
        body = JSON.parse(contents || '{}');
      } catch (_err) {
        body = {};
      }

      const action = String(body.action || '').trim();

      if (action === 'ensureSlipFolder') {
        const parentId = String(body.parentFolderId || '').trim();
        const yearName = String(body.yearFolderName || '').trim();
        const ymName   = String(body.ymFolderName || '').trim();

        const result = ensureSlipFolder_(parentId, yearName, ymName);
        return jsonResponse_(result);
      }

      // Unknown JSON action
      return jsonResponse_({
        status: 'error',
        message: 'Unknown JSON action: ' + action,
      });
    }

    // ---------- Slip mode: OCR + parsing ----------
    const { file } = resolveSlipFile_(e);

    const vision = callVisionOcrText_(file);
    const rawText = (vision && vision.text) || '';
    const parsed = parseKPlusSlip_(rawText);
    const slipId = parsed.slipId || buildSlipId_(parsed);

    const payload = {
      status: 'ok',
      amount: parsed.amount,
      paidAt: parsed.paidAt,
      bankAccount: parsed.bankAccount,
      bankAccountNumber: parsed.bankAccountNumber || '',
      slipId,
      slipUrl: file.getUrl(),
      ocrDebug: vision ? vision.debug : null,
      rawText,
      metadata: getMetadata_(e),
    };

    return jsonResponse_(payload);
  } catch (err) {
    console.error('AutoImg OCR error', err);
    return jsonResponse_({ status: 'error', message: String(err) });
  }
}

// ===================================================
// Helpers: request parsing / Drive file resolution
// ===================================================
function buildBlobFromRequest_(e) {
  const pd = e && e.postData;
  if (!pd) {
    throw new Error('No postData on request');
  }

  const type = pd.type || 'image/jpeg';
  const filename = sanitizeFilename(String(e?.parameter?.filename || 'slip.jpg'));

  const bytes = pd.bytes;
  const contents = pd.contents;
  const bytesLen = bytes ? bytes.length : 0;
  const contentsLen = contents ? contents.length : 0;

  // Prefer bytes (n8n binary mode)
  if (bytes && bytesLen > 0) {
    console.log('auto-img: using postData.bytes', { filename, type, bytesLen });
    return Utilities.newBlob(bytes, type, filename);
  }

  // Fallback to contents (may be base64 or raw string)
  if (contents && contentsLen > 0) {
    if (looksLikeBase64_(contents)) {
      try {
        const decoded = Utilities.base64Decode(contents.replace(/[\r\n]/g, ''));
        console.log('auto-img: decoded base64 fallback', {
          filename,
          type,
          contentsLen,
          decodedLen: decoded.length,
        });
        return Utilities.newBlob(decoded, type, filename);
      } catch (err) {
        console.warn('auto-img: base64 decode failed, using raw contents', err);
      }
    } else {
      console.log('auto-img: contents appears raw, using directly', {
        filename,
        type,
        contentsLen,
      });
    }
    return Utilities.newBlob(contents, type, filename);
  }

  throw new Error(
    'Empty request body: bytesLen=' +
      bytesLen +
      ', contentsLen=' +
      contentsLen +
      ', type=' +
      type
  );
}

/**
 * Decide which Drive file to use and which folder it should belong to.
 *
 * Priority for target folder:
 *   1) query param slipFolderId (or folderId)
 *   2) script property SLIP_FOLDER_ID
 *   3) no folder (root)
 */
function resolveSlipFile_(e) {
  const fileId = String(e?.parameter?.fileId || '').trim();

  // Case 1: n8n already uploaded the file to Drive and passes fileId
  if (fileId) {
    const existing = DriveApp.getFileById(fileId);

    // Just make sure it is viewable with link.
    try {
      existing.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch (err) {
      console.warn('auto-img: failed to set sharing on existing file', err);
    }

    console.log('auto-img: using existing Drive file', {
      fileId,
      name: existing.getName(),
      size: existing.getSize(),
      mime: existing.getMimeType(),
    });

    // ⚠️ IMPORTANT:
    // Do NOT move/add the file to SLIP_FOLDER_ID here.
    // It will stay in the folder that n8n uploaded it to
    // (CheckIn_Slip, Penalty_Slip, Others_Slip, etc.).
    return { file: existing, created: false };
  }

  // Case 2: binary sent directly in HTTP body (no fileId)
  const blob = buildBlobFromRequest_(e);
  const folder =
    SLIP_FOLDER_ID ? DriveApp.getFolderById(SLIP_FOLDER_ID) : DriveApp.getRootFolder();

  const createdFile = folder.createFile(blob);
  createdFile.setDescription('Slip uploaded via n8n OCR');
  createdFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  console.log('auto-img: saved file from raw body', {
    name: createdFile.getName(),
    size: createdFile.getSize(),
    mime: createdFile.getMimeType(),
    parentFolderId: folder.getId(),
  });

  return { file: createdFile, created: true };
}


function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function getProvidedSecret_(e) {
  const headers = e?.headers || {};
  return (
    headers['X-Worker-Secret'] ||
    headers['x-worker-secret'] ||
    e?.parameter?.workerSecret ||
    e?.parameter?.secret ||
    ''
  );
}

function getMetadata_(e) {
  const params = e?.parameter || {};
  const keys = ['mode', 'room', 'lineUserId', 'flowId', 'ticketId', 'reason', 'type'];
  const meta = {};
  keys.forEach((key) => {
    if (params[key]) {
      meta[key] = params[key];
    }
  });
  return meta;
}

function looksLikeBase64_(value) {
  if (!value) return false;
  if (/[\x00-\x08\x0E-\x1F]/.test(value)) return false;
  const normalized = value.replace(/[\r\n\s]/g, '');
  if (!normalized || normalized.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(normalized);
}

function jsonResponse_(payload, opts = {}) {
  const textOut = ContentService.createTextOutput(JSON.stringify(payload));
  textOut.setMimeType(opts.mimeType || ContentService.MimeType.JSON);
  return textOut;
}

// ===================================================
// Vision OCR
// ===================================================
function callVisionOcrText_(file) {
  if (!VISION_SA_KEY) {
    throw new Error('Missing VISION_SA_KEY');
  }
  const sa = JSON.parse(VISION_SA_KEY);

  const blob = file.getBlob();
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-vision',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const toB64 = (obj) => Utilities.base64EncodeWebSafe(JSON.stringify(obj));
  const unsigned = `${toB64(header)}.${toB64(claim)}`;
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(unsigned, sa.private_key)
  );
  const jwt = `${unsigned}.${signature}`;

  const tokenRes = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    },
    muteHttpExceptions: true,
  });
  const token = JSON.parse(tokenRes.getContentText()).access_token;
  if (!token) {
    throw new Error('Failed to acquire Vision access token');
  }

  const visionBody = {
    requests: [
      {
        image: { content: Utilities.base64Encode(blob.getBytes()) },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
        imageContext: { languageHints: ['th', 'en'] },
      },
    ],
  };

  const res = UrlFetchApp.fetch('https://vision.googleapis.com/v1/images:annotate', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(visionBody),
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error(`Vision API error ${code}: ${text}`);
  }
  const body = JSON.parse(text);
  const response = body?.responses?.[0] || {};

  let extracted = (response?.fullTextAnnotation?.text || '').trim();
  if (!extracted && Array.isArray(response?.textAnnotations) && response.textAnnotations.length > 0) {
    extracted = (response.textAnnotations[0].description || '').trim();
  }

  if (!extracted) {
    console.warn('Vision returned empty text', {
      annotations: (response?.textAnnotations || []).length,
      hasFullText: !!response?.fullTextAnnotation?.text,
      error: response?.error,
    });
  }

  return { text: extracted, debug: `Vision HTTP ${code}` };
}

// ===================================================
// Parsing K+ slip: amount, date, receiver account
// ===================================================
function parseKPlusSlip_(text) {
  const amount = parseAmountFromText_(text);
  const paidAt = parseDateFromText_(text);
  const receiver = detectReceiverAccountFromSlip_(text);
  const bankAccountCode = receiver ? receiver.meta.code : '';
  const bankAccountNumber = receiver ? receiver.accountNumber : '';

  const parsed = {
    amount,
    paidAt,
    bankAccount: bankAccountCode,
    bankAccountNumber,
  };
  parsed.slipId = buildSlipId_(parsed);
  return parsed;
}

function detectReceiverAccountFromSlip_(text) {
  const lines = extractAccountLinesFromSlip_(text);
  if (!lines.length) return null;
  const candidate = lines.length > 1 ? lines[1] : lines[0];
  const byMasked = matchReceiverAccountMasked_(candidate.masked || candidate.raw) ||
    matchReceiverAccountDigits_(candidate.digits);
  if (byMasked) return byMasked;

  // Fallback: scan all lines for any digit-run that matches our receiver tails
  const allLines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < allLines.length; i += 1) {
    const digits = onlyDigits_(allLines[i]);
    if (digits && digits.length >= 4) {
      const m = matchReceiverAccountDigits_(digits);
      if (m) return m;
    }
  }
  return null;
}

function extractAccountLinesFromSlip_(text) {
  if (!text) return [];
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (!/[xX]/.test(raw)) continue;
    const normalized = raw.replace(/[^0-9xX-]/g, '');
    const masked = normalized.replace(/-/g, '');
    const digits = onlyDigits_(normalized);
    if (normalized.length >= 7 && digits.length >= 4) {
      out.push({ raw, masked, digits });
    }
  }
  return out;
}

function matchReceiverAccountMasked_(masked) {
  if (!masked) return null;
  const cleaned = String(masked).replace(/[^0-9xX]/g, '').toLowerCase();
  if (!cleaned || cleaned.indexOf('x') === -1) return null;
  const pattern = '^' + cleaned.replace(/x/g, '\\d') + '$';
  const re = new RegExp(pattern);
  for (let i = 0; i < RECEIVER_ACCOUNT_LIST.length; i += 1) {
    const accountNumber = RECEIVER_ACCOUNT_LIST[i];
    if (accountNumber.length !== cleaned.length) continue;
    if (re.test(accountNumber)) {
      return { accountNumber, meta: RECEIVER_ACCOUNTS[accountNumber] };
    }
  }
  return null;
}

function matchReceiverAccountDigits_(digits) {
  const cleaned = onlyDigits_(digits);
  if (!cleaned) return null;
  if (RECEIVER_ACCOUNTS[cleaned]) {
    return { accountNumber: cleaned, meta: RECEIVER_ACCOUNTS[cleaned] };
  }

  const suffixes = [6, 4];
  for (let s = 0; s < suffixes.length; s += 1) {
    const len = suffixes[s];
    if (cleaned.length < len) continue;
    const suffix = cleaned.slice(-len);
    for (let i = 0; i < RECEIVER_ACCOUNT_LIST.length; i += 1) {
      const accountNumber = RECEIVER_ACCOUNT_LIST[i];
      if (accountNumber.slice(-len) === suffix) {
        return { accountNumber, meta: RECEIVER_ACCOUNTS[accountNumber] };
      }
    }
  }
  return null;
}

function onlyDigits_(value) {
  if (!value) return '';
  return String(value).replace(/\D+/g, '');
}

const AMOUNT_LABEL_RE = /(จำนวนเงิน|จำนวน\s*เงิน|จำนวน\b|ยอดโอน|ยอดเงิน|amount|total|เงินออก|เงินเข้า)/i;
const FEE_LABEL_RE = /(ค่าธรรมเนียม|fee)/i;

function parseMoneyNumber_(raw) {
  if (!raw) return null;
  const num = parseFloat(String(raw).replace(/,/g, ''));
  if (!Number.isFinite(num)) return null;
  return Math.abs(num);
}

function extractAmountFromLine_(line) {
  if (!line) return null;

  // Currency suffix (บาท/THB/฿)
  let m = line.match(/(-?\d{1,3}(?:,\d{3})*(?:[.,]\d{1,2})?)\s*(บาท|thb|฿)/i);
  if (m) return parseMoneyNumber_(m[1]);

  // Currency prefix (฿ or B), but only when prefixed by whitespace/bracket/start
  m = line.match(/(?:^|[\s\(\[\{])(?:฿|B)\s*(-?\d{1,3}(?:,\d{3})*(?:[.,]\d{1,2})?)/i);
  if (m) return parseMoneyNumber_(m[1]);

  // Generic number (last resort for labeled lines)
  m = line.match(/-?\d{1,3}(?:,\d{3})*(?:[.,]\d{1,2})?/);
  if (m) return parseMoneyNumber_(m[0]);

  return null;
}

function parseAmountFromText_(text) {
  if (!text) return null;

  const lines = String(text)
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter(Boolean);

  // 1) Prefer labeled amount lines (จำนวนเงิน/จำนวน/เงินออก/etc.) and next line.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FEE_LABEL_RE.test(line)) continue;
    const next = i + 1 < lines.length ? lines[i + 1] : '';
    const combined = `${line} ${next}`;

    if (AMOUNT_LABEL_RE.test(line)) {
      const amt = extractAmountFromLine_(combined);
      if (amt != null) return amt;
    }

    // 2) If the line itself carries currency, try it.
    if (/(บาท|thb|฿)/i.test(line) || /(?:^|[\s\(\[\{])(?:฿|B)\s*\d/i.test(line)) {
      const amt = extractAmountFromLine_(line);
      if (amt != null) return amt;
    }
  }

  // 3) Fallback: currency prefix across whole text (avoid Thai-word glued cases)
  const prefixRe = /(?:^|[\s\(\[\{])(?:\u0E3F|B)\s*(-?\d{1,3}(?:,\d{3})*(?:[.,]\d{1,2})?)/ig;
  let pm;
  const prefixNums = [];
  while ((pm = prefixRe.exec(text))) {
    const num = parseMoneyNumber_(pm[1]);
    if (num != null) prefixNums.push(num);
  }
  if (prefixNums.length) {
    return prefixNums.sort((a, b) => b - a)[0];
  }

  // 4) Fallback: take the largest money-looking number (with punctuation) in the text
  const nums = [];
  const reAll = /\b-?\d{1,3}(?:,\d{3})*(?:[.,]\d{1,2})?\b/g;
  let mm;
  while ((mm = reAll.exec(text))) {
    const num = parseMoneyNumber_(mm[0]);
    if (num != null) nums.push(num);
  }
  if (nums.length) {
    return nums.sort((a, b) => b - a)[0];
  }
  return null;
}

function parseDateFromText_(text) {
  if (!text) {
    return new Date().toISOString();
  }

  const isoMatch = text.match(
    /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[T\s,]+(\d{1,2}:\d{2}))?/
  );
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    const time = isoMatch[4] || '00:00';
    return formatIsoDate_(year, month, day, time);
  }

  // dd/mm/yy or dd/mm/yyyy
  const dmyMatch = text.match(
    /(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})(?:[T\s,]+(\d{1,2}:\d{2}))?/i
  );
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10);
    const year = normalizeYear_(dmyMatch[3]);
    const time = dmyMatch[4] || '00:00';
    if (year) {
      return formatIsoDate_(year, month, day, time);
    }
  }

  const thaiRegex = /(\d{1,2})\s*([^\d\s]+)\s*(\d{2,4})(?:[,\s\-]+(\d{1,2}:\d{2}))?/i;
  const thaiMatch = text.match(thaiRegex);
  if (thaiMatch) {
    const day = parseInt(thaiMatch[1], 10);
    const monthToken = normalizeMonthName_(thaiMatch[2]);
    const mappedMonth =
      MONTHS_MAP[monthToken] || MONTHS_MAP[monthToken.replace('.', '')];
    const rawYear = thaiMatch[3];
    const timeToken = thaiMatch[4] || '00:00';
    const year = normalizeYear_(rawYear);
    if (mappedMonth && year) {
      return formatIsoDate_(year, mappedMonth, day, timeToken);
    }
  }

  return new Date().toISOString();
}

function formatIsoDate_(year, month, day, time) {
  const [hourRaw = '00', minuteRaw = '00'] = time.replace(/[^\d:]/g, '').split(':');
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(
    2,
    '0'
  )}T${String(hourRaw).padStart(2, '0')}:${String(minuteRaw).padStart(
    2,
    '0'
  )}:00+07:00`;
}

function normalizeMonthName_(token) {
  if (!token) return '';
  return token.replace(/[^a-zA-Zก-ฮ]+/g, '').toLowerCase();
}

const MONTHS_MAP = {
  jan: 1,
  january: 1,
  'ม.ค': 1,
  'ม.ค.': 1,
  'มค': 1,
  'มกราคม': 1,
  feb: 2,
  february: 2,
  'ก.พ': 2,
  'ก.พ.': 2,
  'กพ': 2,
  'กุมภาพันธ์': 2,
  mar: 3,
  march: 3,
  'มี.ค': 3,
  'มี.ค.': 3,
  'มีค': 3,
  'มีนาคม': 3,
  apr: 4,
  april: 4,
  'เม.ย': 4,
  'เม.ย.': 4,
  'เมย': 4,
  'เมษายน': 4,
  may: 5,
  'พ.ค': 5,
  'พ.ค.': 5,
  'พค': 5,
  'พฤษภาคม': 5,
  jun: 6,
  june: 6,
  'มิ.ย': 6,
  'มิ.ย.': 6,
  'มิย': 6,
  'มิถุนายน': 6,
  jul: 7,
  july: 7,
  'ก.ค': 7,
  'ก.ค.': 7,
  'กค': 7,
  'กรกฎาคม': 7,
  aug: 8,
  august: 8,
  'ส.ค': 8,
  'ส.ค.': 8,
  'สค': 8,
  'สิงหาคม': 8,
  sep: 9,
  sept: 9,
  september: 9,
  'ก.ย': 9,
  'ก.ย.': 9,
  'กย': 9,
  'กันยายน': 9,
  oct: 10,
  october: 10,
  'ต.ค': 10,
  'ต.ค.': 10,
  'ตค': 10,
  'ตุลาคม': 10,
  nov: 11,
  november: 11,
  'พ.ย': 11,
  'พ.ย.': 11,
  'พย': 11,
  'พฤศจิกายน': 11,
  dec: 12,
  december: 12,
  'ธ.ค': 12,
  'ธ.ค.': 12,
  'ธค': 12,
  'ธันวาคม': 12,
};

function normalizeYear_(raw) {
  if (!raw) return null;
  const num = parseInt(raw.replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(num)) {
    return null;
  }
  if (num > 2400) {
    return num > 2500 ? num - 543 : num;
  }
  if (num < 100) {
    return 2500 + num - 543;
  }
  return num;
}

function buildSlipId_(data) {
  const d = new Date(data.paidAt || new Date().toISOString());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `SCN-${y}${m}${day}-${hh}${mm}${ss}`;
}

// ===================================================
// Folder helpers (for ensureSlipFolder)
// ===================================================
function getOrCreateSubfolder_(parentFolder, name) {
  if (!name) throw new Error('Missing folder name');
  const it = parentFolder.getFoldersByName(name);
  if (it.hasNext()) {
    return it.next();
  }
  return parentFolder.createFolder(name);
}

function ensureSlipFolder_(parentId, yearName, ymName) {
  if (!parentId) throw new Error('Missing parentId');
  if (!yearName) throw new Error('Missing yearName');
  if (!ymName) throw new Error('Missing ymName');

  const parent = DriveApp.getFolderById(parentId);
  const yearFolder = getOrCreateSubfolder_(parent, yearName);
  const ymFolder = getOrCreateSubfolder_(yearFolder, ymName);

  return {
    status: 'ok',
    yearFolderId: yearFolder.getId(),
    ymFolderId: ymFolder.getId(),
  };
}

function testDriveAuth() {
  const root = DriveApp.getRootFolder();
  Logger.log(root.getName());
}
