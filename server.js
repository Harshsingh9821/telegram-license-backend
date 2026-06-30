// Minimal license-approval backend.
// The Android app POSTs a request, you get a Telegram message with
// Approve/Deny buttons, and the app polls /status until you respond.

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const {
  BOT_TOKEN,
  ADMIN_CHAT_ID,
  WEBHOOK_SECRET,
  API_KEY,        // optional: if set, /request and /status require X-API-Key header
  PORT = 3000,
} = process.env;

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBHOOK_SECRET) {
  console.error('Missing required env vars. Check .env.example');
  process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DB_PATH = path.join(__dirname, 'data', 'devices.json');

// ---- tiny JSON-file store ----
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveStore(store) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2));
}

// ---- telegram helpers ----
async function tg(method, body) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.get('X-API-Key') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

const app = express();
app.use(express.json());

// App calls this first to register a device and trigger your Telegram notification.
app.post('/request', requireApiKey, async (req, res) => {
  const { key, device_id } = req.body || {};
  if (!key || !device_id) {
    return res.status(400).json({ error: 'key and device_id required' });
  }

  const store = loadStore();

  // Already decided? Just confirm current status, don't re-notify.
  if (store[device_id] && store[device_id].status !== 'pending') {
    return res.json({ status: store[device_id].status });
  }

  store[device_id] = { status: 'pending', key, requested_at: Date.now() };
  saveStore(store);

  const text =
    `New license request\n` +
    `Device: ${device_id}\n` +
    `Key: ${key}`;

  await tg('sendMessage', {
    chat_id: ADMIN_CHAT_ID,
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${device_id}` },
        { text: '❌ Deny', callback_data: `deny:${device_id}` },
      ]],
    },
  });

  res.json({ status: 'pending' });
});

// App polls this until status is no longer "pending".
app.get('/status', requireApiKey, (req, res) => {
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });

  const store = loadStore();
  const entry = store[device_id];
  res.json({ status: entry ? entry.status : 'unknown' });
});

// Set this as your bot's webhook URL (includes a secret path segment
// so randos can't hit it): https://yourdomain.com/telegram-webhook/<WEBHOOK_SECRET>
app.post(`/telegram-webhook/:secret`, async (req, res) => {
  if (req.params.secret !== WEBHOOK_SECRET) return res.sendStatus(404);

  const update = req.body;
  const cb = update.callback_query;
  if (cb && cb.data) {
    const [action, deviceId] = cb.data.split(':');
    if ((action === 'approve' || action === 'deny') && deviceId) {
      const store = loadStore();
      if (store[deviceId]) {
        store[deviceId].status = action === 'approve' ? 'approved' : 'denied';
        store[deviceId].decided_at = Date.now();
        saveStore(store);
      }

      await tg('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: action === 'approve' ? 'Approved' : 'Denied',
      });

      await tg('editMessageText', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: `${cb.message.text}\n\n— ${action.toUpperCase()} —`,
      });
    }
  }

  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`License backend listening on :${PORT}`));
