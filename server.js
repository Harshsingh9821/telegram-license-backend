require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const { BOT_TOKEN, ADMIN_CHAT_ID, WEBHOOK_SECRET, PORT = 3000 } = process.env;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const DB_PATH = path.join(__dirname, 'data', 'devices.json');

const app = express();
app.use(express.json());

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

app.post('/request', async (req, res) => {
    const { key, device_id } = req.body;
    const store = loadStore();
    store[device_id] = { status: 'pending', key, requested_at: Date.now() };
    await saveStore(store);

    await tg('sendMessage', {
        chat_id: ADMIN_CHAT_ID,
        text: `New license request\nDevice: ${device_id}\nKey: ${key}`,
        reply_markup: {
            inline_keyboard: [[
                { text: '✅ 1 Day', callback_data: `approve:${device_id}:1` },
                { text: '✅ 7 Days', callback_data: `approve:${device_id}:7` },
                { text: '❌ Deny', callback_data: `deny:${device_id}` }
            ]]
        }
    });
    res.json({ status: 'pending' });
});

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

app.post(`/telegram-webhook/:secret`, async (req, res) => {
    if (req.params.secret !== WEBHOOK_SECRET) return res.sendStatus(404);
    const cb = req.body.callback_query;
    if (cb) {
        const [action, deviceId, days] = cb.data.split(':');
        const store = loadStore();
        if (store[deviceId]) {
            if (action === 'approve') {
                store[deviceId].status = 'approved';
                store[deviceId].expires_at = Date.now() + (parseInt(days) * 86400000);
            } else {
                store[deviceId].status = 'denied';
            }
            await saveStore(store);
        }
    }
    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
