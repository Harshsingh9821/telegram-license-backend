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
    console.error('Missing required environment variables.');
    process.exit(1);
}

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DB_PATH = path.join(__dirname, 'data', 'devices.json');

// --- Helper Functions ---
function loadStore() {
    try {
        if (!fs.existsSync(DB_PATH)) return {};
        return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch { return {}; }
}

function saveStore(store) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2));
}

async function tg(method, body) {
    try {
        const res = await fetch(`${TELEGRAM_API}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return await res.json();
    } catch (e) {
        console.error(`Telegram API Error (${method}):`, e);
        return { ok: false };
    }
}

const app = express();
app.use(express.json());

// --- Endpoints ---

// 1. Android App Request
app.post('/request', (req, res) => {
    const { key, device_id } = req.body || {};
    if (!key || !device_id) return res.status(400).json({ error: 'Missing data' });

    const store = loadStore();
    const existing = store[device_id];

    // Spam prevention: if already pending, don't re-notify Telegram
    if (existing && existing.status === 'pending') {
        return res.json({ status: 'pending' });
    }

    // Mark as pending and notify
    store[device_id] = { status: 'pending', key, requested_at: Date.now() };
    saveStore(store);

    tg('sendMessage', {
        chat_id: ADMIN_CHAT_ID,
        text: `New license request\nDevice: ${device_id}\nKey: ${key}`,
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

// 2. Android App Heartbeat
app.get('/status', (req, res) => {
    const { device_id } = req.query;
    const store = loadStore();
    res.json({ status: store[device_id] ? store[device_id].status : 'denied' });
});

// 3. Telegram Webhook (The "Fix" for stuck buttons)
app.post(`/telegram-webhook/:secret`, async (req, res) => {
    if (req.params.secret !== WEBHOOK_SECRET) return res.sendStatus(404);

    const cb = req.body.callback_query;
    if (cb && cb.data) {
        // Acknowledge the click immediately to stop loading animation
        await tg('answerCallbackQuery', { callback_query_id: cb.id });

        const [action, deviceId] = cb.data.split(':');
        const store = loadStore();

        if (store[deviceId]) {
            store[deviceId].status = (action === 'approve') ? 'approved' : 'denied';
            saveStore(store);

            // Update Telegram message buttons dynamically
            const newKeyboard = (store[deviceId].status === 'approved') 
                ? [[ { text: '🚫 Revoke Access', callback_data: `deny:${deviceId}` } ]]
                : [[ { text: '✅ Re-Approve', callback_data: `approve:${deviceId}` } ]];

            await tg('editMessageText', {
                chat_id: cb.message.chat.id,
                message_id: cb.message.message_id,
                text: `License managed\nDevice: ${deviceId}\nStatus: ${store[deviceId].status.toUpperCase()}`,
                reply_markup: { inline_keyboard: newKeyboard }
            });
        }
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Backend live on port ${PORT}`));
