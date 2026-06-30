require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const {
    BOT_TOKEN,
    ADMIN_CHAT_ID,
    WEBHOOK_SECRET,
    API_KEY, 
    PORT = 3000,
} = process.env;

if (!BOT_TOKEN || !ADMIN_CHAT_ID || !WEBHOOK_SECRET) {
    console.error('Missing required env vars.');
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

// 1 & 2. Handle Requests, Spam Prevention, and Re-installs
app.post('/request', requireApiKey, async (req, res) => {
    const { key, device_id } = req.body || {};
    if (!key || !device_id) {
        return res.status(400).json({ error: 'key and device_id required' });
    }

    const store = loadStore();
    const existing = store[device_id];

    if (existing) {
        // Prevent Telegram Spam: If already pending, just return pending
        if (existing.status === 'pending') {
            return res.json({ status: 'pending' });
        }
        // Normal check-in: If the key matches, return the saved status
        if (existing.key === key) {
            return res.json({ status: existing.status });
        }
        // If the device ID exists but the key is DIFFERENT, they reinstalled the app.
        // It will fall through to the logic below to request fresh approval.
    }

    store[device_id] = { status: 'pending', key, requested_at: Date.now() };
    saveStore(store);

    const text = `New license request\nDevice: ${device_id}\nKey: ${key}\n\nStatus: PENDING`;
    
    await tg('sendMessage', {
        chat_id: ADMIN_CHAT_ID,
        text,
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '✅ Approve', callback_data: `approve:${device_id}` },
                    { text: '❌ Deny', callback_data: `deny:${device_id}` }
                ]
            ]
        }
    });

    res.json({ status: 'pending' });
});

// App polls this until status is no longer "pending"
app.get('/status', requireApiKey, (req, res) => {
    const { device_id } = req.query;
    if (!device_id) return res.status(400).json({ error: 'device_id required' });

    const store = loadStore();
    const entry = store[device_id];
    res.json({ status: entry ? entry.status : 'unknown' });
});

// 3. Webhook with dynamic Revoke/Approve buttons
app.post(`/telegram-webhook/:secret`, async (req, res) => {
    if (req.params.secret !== WEBHOOK_SECRET) return res.sendStatus(404);

    const cb = req.body.callback_query;
    if (cb && cb.data) {
        const [action, deviceId] = cb.data.split(':');
        const store = loadStore();

        if (store[deviceId]) {
            // Determine the new status
            let newStatus = store[deviceId].status;
            if (action === 'approve') newStatus = 'approved';
            if (action === 'deny' || action === 'revoke') newStatus = 'denied';

            store[deviceId].status = newStatus;
            store[deviceId].decided_at = Date.now();
            saveStore(store);

            // Dynamically swap the buttons
            let newKeyboard = [];
            if (newStatus === 'approved') {
                newKeyboard = [[ { text: '🚫 Revoke Access', callback_data: `revoke:${deviceId}` } ]];
            } else {
                newKeyboard = [[ { text: '✅ Re-Approve', callback_data: `approve:${deviceId}` } ]];
            }

            await tg('answerCallbackQuery', {
                callback_query_id: cb.id,
                text: newStatus === 'approved' ? 'Approved!' : 'Denied/Revoked!',
            });

            await tg('editMessageText', {
                chat_id: cb.message.chat.id,
                message_id: cb.message.message_id,
                text: `License managed\nDevice: ${deviceId}\nKey: ${store[deviceId].key}\n\nStatus: ${newStatus.toUpperCase()}`,
                reply_markup: { inline_keyboard: newKeyboard }
            });
        }
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`License backend listening on :${PORT}`));

