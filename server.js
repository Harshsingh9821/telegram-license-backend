require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const { BOT_TOKEN, ADMIN_CHAT_ID, WEBHOOK_SECRET, PORT = 3000 } = process.env;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DB_PATH = path.join(__dirname, 'data', 'devices.json');

const app = express();
app.use(express.json());

// --- Helper Functions ---
function loadStore() {
    if (!fs.existsSync(DB_PATH)) return {};
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

async function tg(method, body) {
    try {
        await fetch(`${TELEGRAM_API}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (e) { console.error('Telegram API Error:', e); }
}

// --- Endpoints ---

// 1. Android App Registration
app.post('/request', async (req, res) => {
    const { device_id } = req.body;
    const store = loadStore();
    store[device_id] = { status: 'pending' };
    fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2));

    await tg('sendMessage', {
        chat_id: ADMIN_CHAT_ID,
        text: `New request: ${device_id}`,
        reply_markup: {
            inline_keyboard: [[
                { text: '✅ Approve', callback_data: `approve:${device_id}` },
                { text: '❌ Deny', callback_data: `deny:${device_id}` }
            ]]
        }
    });
    res.json({ status: 'pending' });
});

// 2. Android App Status Polling
app.get('/status', (req, res) => {
    const { device_id } = req.query;
    const store = loadStore();
    res.json({ status: store[device_id] ? store[device_id].status : 'denied' });
});

// 3. Telegram Webhook: Simple Buttons Only
app.post(`/telegram-webhook/:secret`, async (req, res) => {
    if (req.params.secret !== WEBHOOK_SECRET) return res.sendStatus(404);
    
    const cb = req.body.callback_query;
    if (cb) {
        const [action, deviceId] = cb.data.split(':');
        const store = loadStore();
        
        if (store[deviceId]) {
            store[deviceId].status = (action === 'approve') ? 'approved' : 'denied';
            fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2));
            
            await tg('editMessageText', {
                chat_id: cb.message.chat.id, 
                message_id: cb.message.message_id,
                text: `Device ${deviceId} is now ${store[deviceId].status.toUpperCase()}`
            });
        }
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));
