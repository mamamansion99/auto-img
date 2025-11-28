const PROPS = PropertiesService.getScriptProperties();
const WORKER_SECRET = PROPS.getProperty('WORKER_SECRET') || '';
const CHANNEL_ACCESS_TOKEN =
  PROPS.getProperty('CHANNEL_ACCESS_TOKEN') ||
  PROPS.getProperty('LINE_CHANNEL_ACCESS_TOKEN') ||
  PROPS.getProperty('LINE_ACCESS_TOKEN') ||
  '';

// Admin user to always notify (unchanged from previous requirement)
const ADMIN_USER_ID = 'Ue90558b73d62863e2287ac32e69541a3';

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
        // Always notify the fixed admin user ID
        pushLineText_(ADMIN_USER_ID, 'Image Received');

        // Fetch image content from LINE and run a lightweight slip heuristic
        const messageId = ev.message.id;
        const senderId = ev?.source?.userId || null;
        if (messageId) {
          const blob = fetchLineImage_(messageId);
          const looksLikeSlip = blob ? isLikelySlip_(blob) : false;
          if (looksLikeSlip && senderId) {
            pushLineText_(senderId, 'ตรวจพบว่าภาพนี้น่าจะเป็นสลิปค่ะ');
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
