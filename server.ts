import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import pino from "pino";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const PORT = process.env.PORT || 3000;

// Middleware to serve static files
app.use(express.static(path.join(__dirname, "public")));

let sock: any = null;
let status = "disconnected";

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const qrImage = await QRCode.toDataURL(qr);
            status = "qr-ready";
            io.emit('whatsapp-status', status);
            io.emit('whatsapp-qr', qrImage);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
            status = "disconnected";
            io.emit('whatsapp-status', status);
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            status = "connected";
            io.emit('whatsapp-status', status);
            console.log('WhatsApp Connected!');
        }
    });

    // Handle Incoming Messages
    sock.ev.on('messages.upsert', async (m: any) => {
        const msg = m.messages[0];
        if (!msg.key.fromMe && m.type === 'notify') {
            io.emit('new-message', {
                jid: msg.key.remoteJid,
                text: msg.message?.conversation || msg.message?.extendedTextMessage?.text || "Media Message",
                sender: msg.pushName || "Unknown",
                timestamp: new Date().toLocaleTimeString()
            });
        }
    });
}

// Socket.io Logic
io.on('connection', (socket) => {
    socket.emit('whatsapp-status', status);
    
    socket.on('send-message', async ({ to, text }) => {
        if (sock && status === 'connected') {
            await sock.sendMessage(to, { text });
        }
    });

    socket.on('get-chats', async () => {
        if (sock) {
            const chats = await sock.store?.chats.all() || [];
            socket.emit('chats-loaded', chats);
        }
    });
});

connectToWhatsApp();

httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
