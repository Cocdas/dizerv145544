import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, delay, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pn from 'awesome-phonenumber';

const router = express.Router();

function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
    } catch (e) {
        console.error('Error removing file:', e);
    }
}

router.get('/', async (req, res) => {
    let num = req.query.number;
    if (!num) {
        return res.status(400).send({ code: 'Phone number is required.' });
    }

    let dirs = './session_' + num.replace(/[^0-9]/g, '');
    await removeFile(dirs);

    num = num.replace(/[^0-9]/g, '');
    const phone = pn('+' + num);
    if (!phone.isValid()) {
        if (!res.headersSent) {
            return res.status(400).send({ code: 'Invalid phone number format.' });
        }
        return;
    }
    num = phone.getNumber('e164').replace('+', '');

    async function initiateSession() {
        const { state, saveCreds } = await useMultiFileAuthState(dirs);

        try {
            const { version } = await fetchLatestBaileysVersion();
            let client = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }).child({ level: "fatal" }),
                browser: Browsers.windows('Chrome'),
                markOnlineOnConnect: false,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
            });

            let isFinished = false;

            client.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === 'open') {
                    console.log("✅ Connected! Generating plain Base64 session string...");

                    try {
                        await delay(2000);
                        const credsPath = dirs + '/creds.json';
                        
                        if (fs.existsSync(credsPath)) {
                            // File එක Base64 text එකක් බවට පත් කිරීම (Prefix මුකුත් නැත)
                            const fileData = fs.readFileSync(credsPath);
                            const plainSessionId = Buffer.from(fileData).toString('base64');

                            const userJid = jidNormalizedUser(num + '@s.whatsapp.net');

                            // 1. Plain Session Code එක විතරක් යැවීම (Copy කරගන්න ලේසි වෙන්න)
                            await client.sendMessage(userJid, {
                                text: plainSessionId
                            });

                            // 2. Alert message එක
                            await client.sendMessage(userJid, {
                                text: `⚠️ *DO NOT SHARE THIS SESSION ID WITH ANYONE*\n\nCopy the text above and use it directly as your bot's SESSION_ID.`
                            });

                            console.log("🎉 Session string sent to " + num);
                        }

                        isFinished = true;
                        await delay(2000);
                        await client.ws.close();
                        removeFile(dirs);
                    } catch (error) {
                        console.error("❌ Error sending session:", error);
                        isFinished = true;
                        removeFile(dirs);
                    }
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    if (!isFinished && statusCode !== 401) {
                        console.log("🔁 Reconnecting...");
                        initiateSession();
                    } else {
                        removeFile(dirs);
                    }
                }
            });

            if (!client.authState.creds.registered) {
                await delay(3000);
                try {
                    let code = await client.requestPairingCode(num);
                    code = code?.match(/.{1,4}/g)?.join('-') || code;
                    if (!res.headersSent) {
                        console.log(`Pair code: ${code}`);
                        await res.send({ code });
                    }
                } catch (error) {
                    console.error('Error generating pair code:', error);
                    if (!res.headersSent) {
                        res.status(503).send({ code: 'Failed to generate code.' });
                    }
                }
            }

            client.ev.on('creds.update', saveCreds);
        } catch (err) {
            console.error('Initialization error:', err);
            if (!res.headersSent) {
                res.status(503).send({ code: 'Service Unavailable' });
            }
        }
    }

    await initiateSession();
});

export default router;
