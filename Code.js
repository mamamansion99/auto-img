const PROPS = PropertiesService.getScriptProperties();
const WORKER_SECRET = PROPS.getProperty('WORKER_SECRET') || '';
const CHANNEL_ACCESS_TOKEN =
  PROPS.getProperty('CHANNEL_ACCESS_TOKEN') ||
  PROPS.getProperty('LINE_CHANNEL_ACCESS_TOKEN') ||
  PROPS.getProperty('LINE_ACCESS_TOKEN') ||
  '';

function doPost(e) {
  if (!e || !e.postData || !e.postData.contents) {
    return ContentService.createTextOutput('OK');
  }

  let body = {};
  try {
    body = JSON.parse(e.postData.contents || '{}');
  } catch (err) {
    console.error('AUTO_IMG: invalid JSON', err);
    return ContentService.createTextOutput('OK');
  }

  const hdr = e.headers || {};
  const providedSecret =
    hdr['X-Worker-Secret'] ||
    hdr['x-worker-secret'] ||
    body.workerSecret ||
    body.secret ||
    '';

  if (!WORKER_SECRET || providedSecret !== WORKER_SECRET) {
    console.error('AUTO_IMG: forbidden or missing secret');
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'forbidden' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const events = Array.isArray(body.events) ? body.events : [];
  events.forEach((ev) => {
    try {
      if (ev?.type === 'message' && ev.message?.type === 'image') {
        const messageId = ev.message.id;
        const senderId = ev?.source?.userId || null;
        if (messageId) {
          const blob = fetchLineImage_(messageId);
          const looksLikeSlip = blob ? isLikelySlip_(blob) : false;
          let ocrText = '';
          let slipByOcr = null;
          if (blob) {
            try {
              ocrText = callVisionOcrText_(blob) || '';
              slipByOcr = isLikelySlipText_(ocrText);
            } catch (err) {
              console.error('AUTO_IMG: vision error', err);
            }
          }

          if (senderId) {
            const isSlipFinal = slipByOcr !== null ? slipByOcr : looksLikeSlip;
            const status = isSlipFinal
              ? 'ตรวจพบว่าภาพนี้น่าจะเป็นสลิป (OCR)'
              : 'ภาพนี้ไม่น่าจะเป็นสลิป (OCR)';
            const snippetRaw = (ocrText || '').trim();
            const snippet = snippetRaw ? snippetRaw.slice(0, 500) : '[OCR empty]';
            const msg = `${status}\n\nOCR:\n${snippet}`;
            pushLineText_(senderId, msg);
          }
        }
      }
    } catch (err) {
      console.error('AUTO_IMG: event handler error', err);
    }
  });

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function pushLineText_(to, text) {
  if (!CHANNEL_ACCESS_TOKEN || !to) {
    console.error('AUTO_IMG: missing token or recipient');
    return;
  }

  const url = 'https://api.line.me/v2/bot/message/push';
  const payload = {
    to,
    messages: [{ type: 'text', text: String(text || '') }]
  };

  const options = {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + CHANNEL_ACCESS_TOKEN
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    console.error('AUTO_IMG: push failed', code, res.getContentText());
  }
}

/** Download image content from LINE by messageId */
function fetchLineImage_(messageId) {
  if (!CHANNEL_ACCESS_TOKEN || !messageId) return null;
  const url = 'https://api-data.line.me/v2/bot/message/' + encodeURIComponent(messageId) + '/content';
  const options = {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + CHANNEL_ACCESS_TOKEN
    },
    muteHttpExceptions: true
  };
  const res = UrlFetchApp.fetch(url, options);
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    console.error('AUTO_IMG: fetch image failed', code, res.getContentText());
    return null;
  }
  return res.getBlob();
}

/**
 * Simple slip heuristic:
 * - JPEG/PNG only
 * - size between 30KB and 8MB
 * - aspect ratio tends to be vertical: h/w >= 1.2
 */
function isLikelySlip_(blob) {
  try {
    const type = (blob.getContentType() || '').toLowerCase();
    if (!/^image\/(jpeg|png)$/.test(type)) return false;

    const bytes = blob.getBytes();
    if (!bytes || bytes.length < 30 * 1024 || bytes.length > 8 * 1024 * 1024) return false;

    // Use ImagesService to read dimensions (fast and built-in)
    const img = ImagesService.open(blob);
    const w = img.getWidth();
    const h = img.getHeight();
    if (!w || !h) return false;

    const ratio = h / w;
    return ratio >= 1.2; // vertical-ish typical for bank slips
  } catch (err) {
    console.error('AUTO_IMG: isLikelySlip error', err);
    return false;
  }
}

/** Decide slip from OCR text */
function isLikelySlipText_(text) {
  if (!text) return null;
  const lower = String(text).toLowerCase();
  const keywords = [
    'โอน', 'โอนเงิน', 'บาท', 'สำเร็จ', 'ทำรายการ',
    'promptpay', 'พร้อมเพย์', 'kbank', 'scb', 'krungthai', 'bangkok bank',
    'transfer', 'transferred', 'transaction', 'successful', 'success',
    'slip', 'receipt', 'ref', 'reference', 'bank', 'account', 'payment', 'paid'
  ];
  const hits = keywords.filter((k) => lower.includes(k)).length;
  const hasAmount = /\d[\d,\.]{1,}\s*(บาท|thb|฿)/i.test(text) || /\bthb\s*\d[\d,\.]*/i.test(text);
  const hasRef = /ref[:\s]/i.test(text);
  return hits >= 2 || (hasAmount && (hits >= 1 || hasRef));
}

/** Call Google Vision OCR (Text Detection) using SA key from props */
function callVisionOcrText_(blob) {
  const keyJson = PROPS.getProperty('VISION_SA_KEY');
  if (!keyJson) throw new Error('Missing VISION_SA_KEY');
  const sa = JSON.parse(keyJson);

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-vision',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const toB64 = (obj) => Utilities.base64EncodeWebSafe(JSON.stringify(obj));
  const unsigned = toB64(header) + '.' + toB64(claim);
  const signature = Utilities.base64EncodeWebSafe(
    Utilities.computeRsaSha256Signature(unsigned, sa.private_key)
  );
  const jwt = unsigned + '.' + signature;

  const tokenRes = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });
  const token = JSON.parse(tokenRes.getContentText()).access_token;
  if (!token) throw new Error('No access token from Google');

  const imageB64 = Utilities.base64Encode(blob.getBytes());
  const visionBody = {
    requests: [
      {
        image: { content: imageB64 },
        features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
      }
    ]
  };
  const res = UrlFetchApp.fetch('https://vision.googleapis.com/v1/images:annotate', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(visionBody),
    muteHttpExceptions: true
  });
  const bodyText = res.getContentText();
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    console.error('AUTO_IMG: vision response', code, bodyText);
    throw new Error('Vision API failed ' + code);
  }
  const out = JSON.parse(bodyText);
  return out?.responses?.[0]?.fullTextAnnotation?.text || '';
}
