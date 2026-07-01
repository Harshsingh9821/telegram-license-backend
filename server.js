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

let writeChain = Promise.resolve();
function saveStore(store) {
    writeChain = writeChain.then(() => {
        fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
        fs.writeFileSync(DB_PATH, JSON.stringify(store, null, 2));
    });
    return writeChain;
}

async function tg(method, body) {
    try {
        const res = await fetch(`${TELEGRAM_API}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return await res.json();
    } catch (e) { return { ok: false }; }
}

// --- Endpoints ---

// 1. Android App Registration
app.post('/request', async (req, res) => {
    const { key, device_id } = req.body;
    const store = loadStore();
    store[device_id] = { status: 'pending', key, requested_at: Date.now() };
    await saveStore(store);

    await tg('sendMessage', {
        chat_id: ADMIN_CHAT_ID,
        text: `New Device Registered: ${device_id}\nKey: ${key}\n\nChoose an action:`,
        reply_markup: {
            inline_keyboard: [[
                { text: '✅ Approve (30m)', callback_data: `approve:${device_id}` },
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
    const data = store[device_id];

    if (data && data.status === 'approved' && data.expires_at && Date.now() > data.expires_at) {
        data.status = 'denied';
        saveStore(store);
        tg('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `⚠️ License Expired: ${device_id}` });
        return res.json({ status: 'denied' });
    }
    res.json({ status: data ? data.status : 'denied' });
});

// 3. Telegram Webhook: Hybrid (Buttons + Manual Commands)
app.post(`/telegram-webhook/:secret`, async (req, res) => {
    if (req.params.secret !== WEBHOOK_SECRET) return res.sendStatus(404);
    
    const body = req.body;
    const store = loadStore();

    // Handle Button Clicks
    if (body.callback_query) {
        const cb = body.callback_query;
        const [action, deviceId] = cb.data.split(':');
        
        if (store[deviceId]) {
            store[deviceId].status = (action === 'approve') ? 'approved' : 'denied';
            if (action === 'approve') {
                store[deviceId].expires_at = Date.now() + (30 * 60 * 1000); // 30 min default
            }
            await saveStore(store);
            await tg('editMessageText', {
                chat_id: cb.message.chat.id, message_id: cb.message.message_id,
                text: `✅ ${deviceId} ${action}ed via button (30m expiry).`
            });
        }
    } 
    // Handle Manual Text Commands
    else if (body.message && body.message.text) {
        const [cmd, deviceId, val] = body.message.text.split(':');
        if (cmd === 'approve' && store[deviceId]) {
            store[deviceId].status = 'approved';
            store[deviceId].expires_at = Date.now() + (parseInt(val) * 60 * 1000);
            await saveStore(store);
            await tg('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `✅ ${deviceId} approved for ${val} mins.` });
        } else if (cmd === 'revoke' && store[deviceId]) {
            store[deviceId].status = 'denied';
            await saveStore(store);
            await tg('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `❌ ${deviceId} access revoked.` });
        }
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Backend server running on port ${PORT}`));
