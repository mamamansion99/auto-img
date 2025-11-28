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
        const userId = ev?.source?.userId;
        if (userId) {
          pushLineText_(userId, 'Image Received');
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
