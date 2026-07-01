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

// 1. Android App Request: initial registration
app.post('/request', async (req, res) => {
    const { key, device_id } = req.body;
    const store = loadStore();
    store[device_id] = { status: 'pending', key, requested_at: Date.now() };
    await saveStore(store);

    await tg('sendMessage', {
        chat_id: ADMIN_CHAT_ID,
        text: `New request\nDevice: ${device_id}\nKey: ${key}\n\nUse: approve:${device_id}:minutes`
    });
    res.json({ status: 'pending' });
});

// 2. Android App Heartbeat: status check
app.get('/status', (req, res) => {
    const { device_id } = req.query;
    const store = loadStore();
    const data = store[device_id];

    // Check if expired
    if (data && data.status === 'approved' && data.expires_at && Date.now() > data.expires_at) {
        data.status = 'denied';
        saveStore(store);
        tg('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `⚠️ License Expired: ${device_id}` });
        return res.json({ status: 'denied' });
    }
    res.json({ status: data ? data.status : 'denied' });
});

// 3. Telegram Webhook: manual command parsing
app.post(`/telegram-webhook/:secret`, async (req, res) => {
    if (req.params.secret !== WEBHOOK_SECRET) return res.sendStatus(404);
    
    const msg = req.body.message;
    if (msg && msg.text) {
        const [command, deviceId, val] = msg.text.split(':');
        const store = loadStore();

        if (command === 'approve' && store[deviceId]) {
            // val is in minutes, convert to ms
            const expiresAt = Date.now() + (parseInt(val) * 60 * 1000);
            store[deviceId] = { ...store[deviceId], status: 'approved', expires_at: expiresAt };
            await saveStore(store);
            await tg('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `✅ Approved ${deviceId} for ${val} mins` });
        } 
        else if (command === 'deny' || command === 'revoke') {
            if (store[deviceId]) {
                store[deviceId].status = 'denied';
                await saveStore(store);
                await tg('sendMessage', { chat_id: ADMIN_CHAT_ID, text: `❌ Revoked access for ${deviceId}` });
            }
        }
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
