const PROPS = PropertiesService.getScriptProperties();
const WEBHOOK_SECRET = PROPS.getProperty('WEBHOOK_SECRET') || '';
const SLIP_FOLDER_ID = PROPS.getProperty('SLIP_FOLDER_ID') || '';
const VISION_SA_KEY = PROPS.getProperty('VISION_SA_KEY') || '';

function doPost(e) {
  try {
    const providedSecret = getProvidedSecret_(e);
    if (WEBHOOK_SECRET && providedSecret !== WEBHOOK_SECRET) {
      throw new Error('Missing or invalid secret');
    }

    if (!SLIP_FOLDER_ID) {
      throw new Error('Missing SLIP_FOLDER_ID');
    }

    const blob = buildBlobFromRequest_(e);
    const folder = getSlipFolder_();
    const file = folder.createFile(blob);
    file.setDescription('Slip uploaded via n8n OCR');
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

    const vision = callVisionOcrText_(file);
    const rawText = (vision && vision.text) || '';
    const parsed = parseKPlusSlip_(rawText);
    const slipId = parsed.slipId || buildSlipId_(parsed);
    const payload = {
      status: 'ok',
      amount: parsed.amount,
      paidAt: parsed.paidAt,
      bankAccount: parsed.bankAccount,
      slipId,
      slipUrl: file.getUrl(),
      ocrDebug: vision ? vision.debug : null,
      rawText,
      metadata: getMetadata_(e),
    };

    return jsonResponse_(payload);
  } catch (err) {
    console.error('AutoImg OCR error', err);
    return jsonResponse_(
      { status: 'error', message: String(err) },
      { mimeType: ContentService.MimeType.JSON }
    );
  }
}

function buildBlobFromRequest_(e) {
  const contents = e?.postData?.contents;
  if (!contents) {
    throw new Error('Empty request body');
  }
  const contentType = e?.postData?.type || 'image/jpeg';
  const filename = sanitizeFilename(String(e?.parameter?.filename || 'slip.jpg'));
  return Utilities.newBlob(contents, contentType, filename);
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function getSlipFolder_() {
  return DriveApp.getFolderById(SLIP_FOLDER_ID);
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
  const keys = ['mode', 'room', 'lineUserId', 'flowId', 'ticketId'];
  const meta = {};
  keys.forEach((key) => {
    if (params[key]) {
      meta[key] = params[key];
    }
  });
  return meta;
}

function jsonResponse_(payload, opts = {}) {
  const textOut = ContentService.createTextOutput(JSON.stringify(payload));
  textOut.setMimeType(opts.mimeType || ContentService.MimeType.JSON);
  return textOut;
}

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
  const extracted = body?.responses?.[0]?.fullTextAnnotation?.text || '';
  return { text: extracted, debug: `Vision HTTP ${code}` };
}

function parseKPlusSlip_(text) {
  const parsed = {
    amount: parseAmountFromText_(text),
    bankAccount: parseAccountFromText_(text),
    paidAt: parseDateFromText_(text),
  };
  parsed.slipId = buildSlipId_(parsed);
  return parsed;
}

function parseAmountFromText_(text) {
  if (!text) return null;
  const m = /([0-9][\d,\.]{0,15})\s*(บาท|thb|฿)/i.exec(text);
  if (!m) return null;
  const raw = m[1].replace(/,/g, '');
  const num = parseFloat(raw);
  return Number.isFinite(num) ? num : null;
}

function parseAccountFromText_(text) {
  if (!text) return '';
  const match = text.match(/(\d{2,3}-\d-[\d-]{4,16}-\d)/);
  return match ? match[1] : '';
}

function parseDateFromText_(text) {
  if (!text) {
    return new Date().toISOString();
  }

  const isoMatch = text.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[T\s](\d{1,2}:\d{2}))?/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    const time = isoMatch[4] || '00:00';
    return formatIsoDate_(year, month, day, time);
  }

  const thaiRegex =
    /(\d{1,2})\s*([^\d\s]+)\s*(\d{2,4})\s*(\d{1,2}:\d{2})/i;
  const thaiMatch = text.match(thaiRegex);
  if (thaiMatch) {
    const day = parseInt(thaiMatch[1], 10);
    const monthToken = normalizeMonthName_(thaiMatch[2]);
    const mappedMonth = MONTHS_MAP[monthToken] || MONTHS_MAP[monthToken.replace('.', '')];
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
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(
    hourRaw
  ).padStart(2, '0')}:${String(minuteRaw).padStart(2, '0')}:00+07:00`;
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
  'มกราคม': 1,
  feb: 2,
  february: 2,
  'ก.พ': 2,
  'ก.พ.': 2,
  'กุมภาพันธ์': 2,
  mar: 3,
  march: 3,
  'มี.ค': 3,
  'มี.ค.': 3,
  'มีนาคม': 3,
  apr: 4,
  april: 4,
  'เม.ย': 4,
  'เม.ย.': 4,
  'เมษายน': 4,
  may: 5,
  'พ.ค': 5,
  'พ.ค.': 5,
  'พฤษภาคม': 5,
  jun: 6,
  june: 6,
  'มิ.ย': 6,
  'มิ.ย.': 6,
  'มิถุนายน': 6,
  jul: 7,
  july: 7,
  'ก.ค': 7,
  'ก.ค.': 7,
  'กรกฎาคม': 7,
  aug: 8,
  august: 8,
  'ส.ค': 8,
  'ส.ค.': 8,
  'สิงหาคม': 8,
  sep: 9,
  sept: 9,
  september: 9,
  'ก.ย': 9,
  'ก.ย.': 9,
  'กันยายน': 9,
  oct: 10,
  october: 10,
  'ต.ค': 10,
  'ต.ค.': 10,
  'ตุลาคม': 10,
  nov: 11,
  november: 11,
  'พ.ย': 11,
  'พ.ย.': 11,
  'พฤศจิกายน': 11,
  dec: 12,
  december: 12,
  'ธ.ค': 12,
  'ธ.ค.': 12,
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
