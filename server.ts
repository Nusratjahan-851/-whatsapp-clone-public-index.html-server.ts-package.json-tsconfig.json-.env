import express from "express";
import path from "path";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";
import { createServer } from "http";
import { Server } from "socket.io";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadContentFromMessage } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import fs from "fs";
import multer from "multer";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

dotenv.config();

// ==========================================
// Firebase Admin SDK Initialization
// ==========================================
let adminApp: any = null;
let firestoreDb: any = null;
let storageBucket: any = null;

try {
  const configPath = path.join(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const apps = getApps();
    
    let credentialOption = undefined;
    let serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
    
    // Auto-recovery: If the user mistakenly pasted the Service Account JSON into AUTH_DIR, extract it!
    const authDirValue = process.env.AUTH_DIR;
    if (!serviceAccountJson && authDirValue && authDirValue.trim().startsWith("{")) {
      serviceAccountJson = authDirValue;
      console.log("Detected Firebase service account JSON stored in AUTH_DIR variable. Automatically mapping it to Firebase credentials.");
    }

    if (serviceAccountJson) {
      try {
        credentialOption = cert(JSON.parse(serviceAccountJson));
        console.log("Using Firebase service account credentials.");
      } catch (credErr) {
        console.error("Failed to parse service account credential:", credErr);
      }
    }

    if (apps.length === 0) {
      const appOptions: any = {
        projectId: firebaseConfig.projectId,
        storageBucket: firebaseConfig.storageBucket,
      };
      if (credentialOption) {
        appOptions.credential = credentialOption;
      }
      adminApp = initializeApp(appOptions);
    } else {
      adminApp = apps[0];
    }
    
    firestoreDb = getFirestore(adminApp, firebaseConfig.firestoreDatabaseId || undefined);
    if (firestoreDb && typeof firestoreDb.settings === "function") {
      try {
        firestoreDb.settings({ ignoreUndefinedProperties: true });
        console.log("Firestore settings configured to ignore undefined properties.");
      } catch (settingsErr) {
        console.warn("Could not apply firestoreDb.settings (it may have been initialized elsewhere):", settingsErr);
      }
    }
    
    if (firebaseConfig.storageBucket) {
      storageBucket = getStorage(adminApp).bucket(firebaseConfig.storageBucket);
    }
    console.log("Firebase Admin SDK initialized successfully on backend.");
  } else {
    console.warn("firebase-applet-config.json not found. Firebase features will run in fallback mode.");
  }
} catch (err) {
  console.error("Failed to initialize Firebase Admin SDK:", err);
}

const app = express();

const PORT = 3000;

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
  },
});

// Global WhatsApp (Baileys) Connection State
let sock: any = null;
let whatsappStatus: "disconnected" | "connecting" | "qr-ready" | "pairing-code-ready" | "connected" = "disconnected";
let qrCodeData: string | null = null;
let pairingCode: string = "";
let connectedUser: any = null;
let whatsappError: string | null = null;
let reconnectTimeout: NodeJS.Timeout | null = null;

function sanitizeWhatsAppPhone(phone: string): string {
  let cleaned = phone.replace(/\D/g, ""); // Keep only digits
  if (cleaned.length < 5) return cleaned;

  // Bangladesh Check:
  if (cleaned.length === 11 && cleaned.startsWith("01")) {
    cleaned = "88" + cleaned;
  } else if (cleaned.length === 10 && cleaned.startsWith("1")) {
    cleaned = "880" + cleaned;
  }
  // Saudi Arabia Check:
  else if (cleaned.length === 10 && cleaned.startsWith("05")) {
    cleaned = "966" + cleaned.substring(1);
  } else if (cleaned.length === 9 && cleaned.startsWith("5")) {
    cleaned = "966" + cleaned;
  }
  // India Check:
  else if (cleaned.length === 10 && /^[6789]/.test(cleaned)) {
    cleaned = "91" + cleaned;
  }
  return cleaned;
}

// Track remote pairing request variables
let currentPairingPhoneNumber: string = "";
let pairingCodeRefreshTimeout: NodeJS.Timeout | null = null;

function clearPairingCodeRefresh() {
  if (pairingCodeRefreshTimeout) {
    clearTimeout(pairingCodeRefreshTimeout);
    pairingCodeRefreshTimeout = null;
  }
}

// Track all active socket connections
const activeSockets = new Set<any>();

// Global Store (In-memory data cache for chats, messages, and contacts)
const store: {
  chats: Record<string, any>;
  messages: Record<string, any[]>;
  contacts: Record<string, any>;
} = {
  chats: {},
  messages: {},
  contacts: {},
};

let activeStorePhone: string | null = null;

function getAuthDir(): string {
  const envDir = process.env.AUTH_DIR;
  if (envDir && envDir.trim().startsWith("{")) {
    console.warn("WARNING: process.env.AUTH_DIR contains a JSON string instead of a directory path. Overriding and defaulting to process.cwd().");
    return process.cwd();
  }
  return envDir || process.cwd();
}

function getStoreFile() {
  const baseDir = getAuthDir();
  if (activeStorePhone) {
    return path.join(baseDir, `whatsapp_store_${activeStorePhone}.json`);
  }
  return path.join(baseDir, "whatsapp_store.json");
}

let saveTimeout: NodeJS.Timeout | null = null;

function saveStore() {
  if (saveTimeout) clearTimeout(saveTimeout);

  saveTimeout = setTimeout(() => {
    try {
      const file = getStoreFile();
      fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
      console.log(`[Disk Cache] Store data saved to file successfully. Total chats: ${Object.keys(store.chats).length}`);
      
      // Trigger asynchronous Firebase Cloud Backup
      if (typeof backupToFirestore === "function") {
        backupToFirestore();
      }
    } catch (err) {
      console.error("Error saving store file:", err);
    }
  }, 500);
}

function loadStore(phone?: string) {
  // Clear any existing cached store completely to prevent residual data leak!
  store.chats = {};
  store.messages = {};
  store.contacts = {};

  if (phone) {
    activeStorePhone = phone;
  }

  try {
    const file = getStoreFile();
    if (fs.existsSync(file)) {
      const data = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(data);
      if (parsed.chats) store.chats = parsed.chats;
      if (parsed.messages) store.messages = parsed.messages;
      if (parsed.contacts) store.contacts = parsed.contacts;
      console.log(`Loaded cached store from file "${file}" successfully. Chats count:`, Object.keys(store.chats).length);
    } else {
      console.log(`No cached store file found at "${file}". Starting with an empty store for this account.`);
    }

    // Trigger asynchronous Firebase Cloud Restore to auto-heal/sync state
    if (activeStorePhone && typeof restoreFromFirestore === "function") {
      restoreFromFirestore(activeStorePhone);
    }
  } catch (err) {
    console.error("Error loading store file:", err);
  }
}

// Load default store on startup
loadStore();

// ==========================================
// profile picture and contact info retriever
// ==========================================
const fetchingProfilePics = new Set<string>();

async function getContactInfo(sockInstance: any, jid: string) {
  if (!jid || !sockInstance) return store.contacts[jid] || { id: jid };
  if (fetchingProfilePics.has(jid)) {
    return store.contacts[jid] || { id: jid };
  }
  fetchingProfilePics.add(jid);

  let changed = false;
  if (!store.contacts[jid]) {
    store.contacts[jid] = { id: jid };
    changed = true;
  }
  
  // For LID contacts, resolve their actual registered phone number (pnJid) from chat if not already cached
  if (jid.endsWith("@lid") && !store.contacts[jid].pnJid) {
    const chat = store.chats[jid];
    if (chat && chat.pnJid) {
      store.contacts[jid].pnJid = chat.pnJid;
      changed = true;
    }
  }

  // Try to load profile picture from WhatsApp server safely (works for both users and groups)
  if (!store.contacts[jid].imgUrl) {
    try {
      let imgUrl = null;
      // If it is a LID JID and we have its pnJid, we try fetching with pnJid first
      if (jid.endsWith("@lid") && store.contacts[jid].pnJid) {
        imgUrl = await sockInstance.profilePictureUrl(store.contacts[jid].pnJid, "image").catch(() => null);
      }
      if (!imgUrl) {
        imgUrl = await sockInstance.profilePictureUrl(jid, "image").catch(() => null);
      }
      if (imgUrl && store.contacts[jid].imgUrl !== imgUrl) {
        store.contacts[jid].imgUrl = imgUrl;
        changed = true;
      }
    } catch (e) {
      console.log("Error fetching profile picture for:", jid);
    }
  }

  // If it's a group, try to load its subject name dynamically
  if (jid.endsWith("@g.us") && (!store.contacts[jid].name || store.contacts[jid].name === jid.split("@")[0])) {
    try {
      const metadata = await sockInstance.groupMetadata(jid).catch(() => null);
      if (metadata && metadata.subject) {
        store.contacts[jid].name = metadata.subject;
        changed = true;
      }
    } catch (e) {
      console.log("Error fetching group subject for:", jid);
    }
  }

  if (changed) {
    saveStore();
  }
  fetchingProfilePics.delete(jid);
  return store.contacts[jid];
}

// ==========================================
// Background History & Profile Sync Worker
// ==========================================
let isSyncingHistory = false;
let syncProgress = 0;
let syncActionText = "";
let syncCompletedThisRun = false;

async function runBackgroundHistorySync() {
  if (!sock) return;
  if (isSyncingHistory) {
    console.log("History sync is already running.");
    return;
  }

  if (syncCompletedThisRun) {
    console.log("History sync already completed for this run.");
    broadcastToAll("whatsapp:sync-progress", { progress: 100, action: "১০০% সফলভাবে সকল প্রোফাইল ও ইতিহাস লোড হয়েছে!", status: "completed" });
    return;
  }

  console.log("Starting real-time history & profile synchronization worker...");
  isSyncingHistory = true;
  syncProgress = 0;
  syncActionText = "প্রোফাইল এবং চ্যাট তালিকা যাচাই করা হচ্ছে...";
  broadcastToAll("whatsapp:sync-progress", { progress: syncProgress, action: syncActionText, status: "syncing" });

  try {
    // Wait 2.5 seconds to let initial Baileys load settle down
    await new Promise((r) => setTimeout(r, 2500));

    // Get merged contacts to find visible/active chats
    const mergedContacts = getMergedContacts();
    const activeJids = mergedContacts
      .filter(c => c.isActiveChat)
      .map(c => c.id);

    // Filter only JIDs of active chats for immediate fast startup sync (limit to max 60 to prevent connection congestion)
    const jids = Array.from(new Set([
      ...activeJids,
      ...Object.keys(store.chats)
    ]))
    .filter(jid => jid && (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@g.us") || jid.endsWith("@lid")))
    .slice(0, 60);

    const total = jids.length;
    if (total === 0) {
      console.log("No JIDs found to sync.");
      syncProgress = 100;
      syncActionText = "সিঙ্ক সম্পন্ন!";
      isSyncingHistory = false;
      syncCompletedThisRun = true;
      broadcastToAll("whatsapp:sync-progress", { progress: 100, action: syncActionText, status: "completed" });
      return;
    }

    console.log(`Syncing details for ${total} active chats/contacts on startup (Lazy loading the rest).`);
    let completed = 0;

    // Batch active JID processing to be safe, fast, and avoid rate limits
    const batchSize = 5;
    for (let i = 0; i < jids.length; i += batchSize) {
      if (!sock || whatsappStatus !== "connected") {
        console.log("Sync aborted because WhatsApp disconnected.");
        isSyncingHistory = false;
        broadcastToAll("whatsapp:sync-progress", { progress: 0, action: "সংযোগ বিচ্ছিন্ন হয়েছে, সিঙ্ক ব্যাহত!", status: "failed" });
        return;
      }

      const batch = jids.slice(i, i + batchSize);
      await Promise.all(batch.map(async (jid) => {
        try {
          // 1. Fetch Name / Contact Info
          if (!store.contacts[jid]) {
            store.contacts[jid] = { id: jid };
          }

          const rawNumber = jid.split("@")[0];
          const currentContact = store.contacts[jid];
          
          // Resolve actual name if empty or is a raw number
          if (!currentContact.name || currentContact.name === rawNumber || currentContact.name === "Unknown Contact") {
            if (jid.endsWith("@g.us")) {
              const meta = await sock.groupMetadata(jid).catch(() => null);
              if (meta && meta.subject) {
                currentContact.name = meta.subject;
              }
            } else {
              // Try parsing pushName from stored messages for this Jid
              const msgs = store.messages[jid] || [];
              const msgWithPushName = msgs.find(m => m.pushName);
              if (msgWithPushName && msgWithPushName.pushName) {
                currentContact.name = msgWithPushName.pushName;
              }
            }
          }

          // 2. Fetch Profile Picture
          if (!currentContact.imgUrl) {
            let picUrl = null;
            if (jid.endsWith("@lid") && currentContact.pnJid) {
              picUrl = await sock.profilePictureUrl(currentContact.pnJid, "image").catch(() => null);
            }
            if (!picUrl) {
              picUrl = await sock.profilePictureUrl(jid, "image").catch(() => null);
            }
            if (picUrl) {
              currentContact.imgUrl = picUrl;
            }
          }

          // We do NOT call heavy fetchStatus or chatsCompose on startup here,
          // because it causes network rate limits and blocks the connection.
          // Instead, profile picture, status, and message history are loaded dynamically (lazy loaded)
          // inside our socket handler "action:click-friend" when the user clicks on a chat!

        } catch (err) {
          console.log(`Failed to sync details for JID: ${jid}`, err);
        } finally {
          completed++;
          syncProgress = Math.min(98, Math.round((completed / total) * 100));
          syncActionText = `চ্যাট তালিকা ও সঠিক তথ্য সিঙ্ক করা হচ্ছে: ${completed}/${total} টি প্রোফাইল...`;
          broadcastToAll("whatsapp:sync-progress", { progress: syncProgress, action: syncActionText, status: "syncing" });
        }
      }));

      // Small delay between batches to avoid overloading the socket connection
      await new Promise((r) => setTimeout(r, 400));
    }

    // Finalize
    syncProgress = 100;
    syncActionText = "১০০% সফলভাবে সকল প্রোফাইল ও ইতিহাস লোড হয়েছে!";
    console.log("Background synchronization completed successfully!");
    syncCompletedThisRun = true;
    saveStore();

    // Broadcast final complete states to frontend
    const updatedMergedContacts = getMergedContacts();
    const mappedChats: Record<string, any[]> = {};
    for (const jid of Object.keys(store.messages)) {
      const sortedHistory = [...(store.messages[jid] || [])].sort((a, b) => {
        return Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0);
      });
      mappedChats[jid] = sortedHistory
        .map((m) => mapMessage(m))
        .filter(Boolean);
    }
    broadcastToAll("whatsapp:chats-loaded", updatedMergedContacts);
    broadcastToAll("whatsapp-history", { contacts: updatedMergedContacts, chats: mappedChats });
    
    // Broadcast progress completion
    broadcastToAll("whatsapp:sync-progress", { progress: 100, action: syncActionText, status: "syncing" });
    
    await new Promise((r) => setTimeout(r, 1000));
    
    broadcastToAll("whatsapp:sync-progress", { progress: 100, action: syncActionText, status: "completed" });
  } catch (globalErr) {
    console.error("Error in runBackgroundHistorySync:", globalErr);
    broadcastToAll("whatsapp:sync-progress", { progress: 0, action: "সিঙ্ক করতে সমস্যা হয়েছে!", status: "failed" });
  } finally {
    isSyncingHistory = false;
  }
}

// ==========================================
// Media & Voice Message Download & Decryption
// ==========================================
const restoreBuffers = (obj: any): any => {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) {
    return obj.map(restoreBuffers);
  }
  if (typeof obj === "object") {
    if (obj.type === "Buffer" && Array.isArray(obj.data)) {
      return Buffer.from(obj.data);
    }
    const resObj: any = {};
    for (const key of Object.keys(obj)) {
      resObj[key] = restoreBuffers(obj[key]);
    }
    return resObj;
  }
  return obj;
};

async function downloadMediaMessage(message: any) {
  try {
    if (!message || !message.message) return null;
    
    const messageType = Object.keys(message.message)[0];
    let mediaMessage = message.message[messageType];
    let type: "audio" | "image" | "video" | "document" = "image";
    
    if (messageType === "audioMessage") {
      type = "audio";
    } else if (messageType === "videoMessage") {
      type = "video";
    } else if (messageType === "documentMessage") {
      type = "document";
    } else if (messageType === "stickerMessage") {
      type = "image"; // Baileys downloadContentFromMessage uses 'image' for stickers
    } else if (messageType === "viewOnceMessage" || messageType === "viewOnceMessageV2") {
      const innerMsg = message.message[messageType]?.message;
      if (innerMsg) {
        const innerType = Object.keys(innerMsg)[0];
        mediaMessage = innerMsg[innerType];
        if (innerType === "audioMessage") type = "audio";
        else if (innerType === "videoMessage") type = "video";
        else if (innerType === "documentMessage") type = "document";
        else if (innerType === "stickerMessage") type = "image";
        else type = "image";
      }
    } else if (messageType === "documentWithCaptionMessage") {
      mediaMessage = message.message.documentWithCaptionMessage?.message?.documentMessage;
      type = "document";
    }

    if (!mediaMessage || (!mediaMessage.url && !mediaMessage.directPath)) return null;

    // Restore any Buffer fields (like mediaKey, fileSha256, etc.) that got serialized as objects (critical for loaded session files)
    const restoredMediaMessage = restoreBuffers(mediaMessage);

    const stream = await downloadContentFromMessage(restoredMediaMessage, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }
    
    const mimeType = restoredMediaMessage.mimetype || (type === "audio" ? "audio/ogg; codecs=opus" : "image/jpeg");

    // Upload to Firebase Storage if available
    if (storageBucket) {
      try {
        const fileId = message.key?.id || `media_${Date.now()}`;
        let ext = "bin";
        if (type === "image") ext = "jpg";
        else if (type === "audio") ext = "ogg";
        else if (type === "video") ext = "mp4";
        else if (mimeType.includes("/")) ext = mimeType.split("/")[1].split(";")[0];

        const storagePath = `whatsapp_media/${activeStorePhone || "global"}/${fileId}.${ext}`;
        const fileRef = storageBucket.file(storagePath);
        
        console.log(`Uploading decrypted WhatsApp media to Firebase Storage (Admin): ${storagePath}`);
        await fileRef.save(buffer, {
          metadata: {
            contentType: mimeType,
          },
        });
        
        const [downloadUrl] = await fileRef.getSignedUrl({
          action: "read",
          expires: "03-09-2491",
        });
        
        console.log(`Firebase Storage upload complete. URL: ${downloadUrl}`);
        return downloadUrl;
      } catch (storageErr: any) {
        console.warn("[Firebase Storage] Upload skipped (falling back to base64 data URI):", storageErr.message || storageErr);
      }
    }
    
    return `data:${mimeType};base64,${buffer.toString("base64")}`;
  } catch (error: any) {
    console.warn("[downloadMediaMessage] Media download failed:", error.message || error);
    return null;
  }
}

async function enrichHistoryMessages(sortedHistory: any[]) {
  return Promise.all(
    sortedHistory.map(async (msg) => {
      let isMedia = false;
      let messageContent = msg.message;
      if (messageContent) {
        const keys = Object.keys(messageContent);
        const outerType = keys[0];
        if (outerType === "viewOnceMessage" || outerType === "viewOnceMessageV2") {
          messageContent = messageContent[outerType]?.message || messageContent;
        } else if (outerType === "documentWithCaptionMessage") {
          messageContent = messageContent[outerType]?.message || messageContent;
        }
        isMedia = !!(
          messageContent?.imageMessage || 
          messageContent?.audioMessage || 
          messageContent?.videoMessage || 
          messageContent?.documentMessage ||
          messageContent?.stickerMessage
        );
      }

      let mediaUrl = null;
      if (isMedia) {
        mediaUrl = await downloadMediaMessage(msg);
      }
      const mapped = mapMessage(msg, mediaUrl || undefined);
      return mapped || {
        id: msg.key?.id || String(Date.now()),
        sender: msg.key?.fromMe ? "me" : "them",
        text: msg.message?.conversation || "Media message",
        timestamp: formatTimestamp(msg.messageTimestamp) || getCurrentFormattedTime(),
        timestampSecs: Number(msg.messageTimestamp || 0),
        type: isMedia ? "image" : "text",
        status: "read",
        fileUrl: mediaUrl || undefined,
      };
    })
  );
}

function broadcastToAll(event: string, data?: any) {
  activeSockets.forEach((socket) => {
    socket.emit(event, data);
  });
}

const formatTimestamp = (timestampInSecs: number) => {
  const date = new Date(timestampInSecs * 1000);
  let hours = date.getHours();
  const minutes = date.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12;
  const minutesStr = minutes < 10 ? "0" + minutes : minutes;
  return `${hours}:${minutesStr} ${ampm}`;
};

const getCurrentFormattedTime = () => {
  const now = new Date();
  let hours = now.getHours();
  const minutes = now.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  hours = hours ? hours : 12;
  const minutesStr = minutes < 10 ? "0" + minutes : minutes;
  return `${hours}:${minutesStr} ${ampm}`;
};

const formatPhoneNumber = (jid: string): string => {
  const num = jid.split("@")[0] || "";
  if (!num) return "";
  const digits = num.replace(/\D/g, "");
  
  // Format Bangladeshi numbers beautifully (e.g., +880 1512-345678)
  if (digits.startsWith("880") && digits.length === 13) {
    return `+880 ${digits.slice(3, 7)}-${digits.slice(7)}`;
  }
  // Format Saudi Arabian numbers beautifully (e.g., +966 50 109 9120)
  if (digits.startsWith("966") && digits.length === 12) {
    return `+966 ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return `+${digits}`;
};

const mapContact = (chat: any, isActiveChatOverride?: boolean) => {
  const jid = chat.id || chat.remoteJid || "";
  const isGroup = jid.endsWith("@g.us");
  const unreadCount = chat.unreadCount || 0;
  
  // Resolve real cached name, avatar, and about description
  const cachedContact = store.contacts[jid] || {};
  const rawNumber = jid.split("@")[0];
  
  // For LID contacts, resolve their actual registered phone number (pnJid) from chat or cache
  let realJid = jid;
  if (jid.endsWith("@lid")) {
    if (chat.pnJid) {
      realJid = chat.pnJid;
    } else if (cachedContact.pnJid) {
      realJid = cachedContact.pnJid;
    }
  }
  const realRawNumber = realJid.split("@")[0];
  
  let name = "";
  if (isGroup) {
    name = chat.name || cachedContact.name || cachedContact.savedName || rawNumber || "Unnamed Group";
  } else {
    // Check saved name, then cached name, then push/notify name, then chat name
    if (cachedContact.savedName && cachedContact.savedName !== rawNumber && !cachedContact.savedName.includes("@")) {
      name = cachedContact.savedName;
    } else if (cachedContact.name && cachedContact.name !== rawNumber && !cachedContact.name.includes("@")) {
      name = cachedContact.name;
    } else if (cachedContact.notify && cachedContact.notify !== rawNumber && !cachedContact.notify.includes("@")) {
      name = cachedContact.notify;
    } else if (chat.name && chat.name !== rawNumber && !chat.name.includes("@")) {
      name = chat.name;
    }
    
    // If not saved, we must show the formatted phone number.
    // Ensure we do NOT show any ID or demo name like John Doe / Unknown Contact.
    if (!name || name === rawNumber || name === "Unknown Contact" || name.startsWith("John Doe")) {
      name = formatPhoneNumber(realJid);
    }
  }

  const avatar = cachedContact.imgUrl || "";
  const about = cachedContact.status || (isGroup ? "WhatsApp Group" : "Hey there! I am using WhatsApp.");

  const isPinned = !!(chat.pin || chat.isPinned || chat.pinned);
  let conversationTimestamp = Number(chat.conversationTimestamp || chat.lastMessageTimestamp || 0);
  
  const msgs = store.messages[jid] || [];
  if (msgs.length > 0) {
    // Find the absolute highest message timestamp to determine chronological sorting correctly
    const maxMsgTs = msgs.reduce((max, m) => {
      const ts = Number(m.messageTimestamp || 0);
      return ts > max ? ts : max;
    }, 0);
    if (maxMsgTs > conversationTimestamp) {
      conversationTimestamp = maxMsgTs;
    }
  }

  let isActiveChat = false;
  if (isActiveChatOverride !== undefined) {
    isActiveChat = isActiveChatOverride;
  } else {
    // If it is a real chat in store.chats, it is ALWAYS an active chat in the inbox, regardless of timestamp!
    isActiveChat = true;
  }

  return {
    id: jid,
    name: name,
    avatar: avatar,
    isGroup,
    unreadCount,
    about: about,
    status: "online" as const,
    phoneNumber: isGroup ? undefined : `+${realRawNumber}`,
    isPinned,
    conversationTimestamp,
    isActiveChat,
  };
};

function getMergedContacts() {
  const allMergedContactsMap = new Map<string, any>();
  
  // First, add all contacts from store.contacts (with isActiveChat = false by default)
  Object.keys(store.contacts).forEach((jid) => {
    if (!jid) return;
    const chatObj = store.chats[jid] || { id: jid };
    allMergedContactsMap.set(jid, mapContact(chatObj, false));
    
    // Background-fetch missing image or group details
    if (sock && (!store.contacts[jid]?.imgUrl || (jid.endsWith("@g.us") && (!store.contacts[jid]?.name || store.contacts[jid]?.name === jid.split("@")[0])))) {
      getContactInfo(sock, jid).then((info) => {
        broadcastToAll("whatsapp:chat-profile-ready", { jid, profile: info });
      });
    }
  });

  // Then, add/override all chats from store.chats (computing isActiveChat dynamically)
  Object.keys(store.chats).forEach((jid) => {
    if (!jid) return;
    const chatObj = store.chats[jid];
    allMergedContactsMap.set(jid, mapContact(chatObj));
    
    // Background-fetch missing image or group details
    if (sock && (!store.contacts[jid]?.imgUrl || (jid.endsWith("@g.us") && (!store.contacts[jid]?.name || store.contacts[jid]?.name === jid.split("@")[0])))) {
      getContactInfo(sock, jid).then((info) => {
        broadcastToAll("whatsapp:chat-profile-ready", { jid, profile: info });
      });
    }
  });

  return Array.from(allMergedContactsMap.values());
}

function clearSessionAndStoreData(phoneOverride?: string) {
  const targetPhone = phoneOverride || activeStorePhone || (connectedUser ? connectedUser.phoneNumber : null);
  const cleanTargetPhone = targetPhone ? sanitizeWhatsAppPhone(String(targetPhone)) : "";

  console.log(`Wiping session data, store, and cache specifically for phone: ${cleanTargetPhone || "default"}...`);
  
  if (cleanTargetPhone) {
    console.log(`[Firebase Cleanup] Target phone detected for cloud wipe: ${cleanTargetPhone}`);
    deleteAccountFromFirestore(cleanTargetPhone).catch((e) => console.error("Firestore automatic logout wipe failed:", e));
    deleteAccountFromStorage(cleanTargetPhone).catch((e) => console.error("Storage automatic logout wipe failed:", e));
  } else {
    console.warn("[Firebase Cleanup] No active phone number found to wipe cloud storage/firestore.");
  }

  // Reset synchronization flags
  isSyncingHistory = false;
  syncProgress = 0;
  syncActionText = "";
  syncCompletedThisRun = false;

  // 1. Reset in-memory store if it matches the current active store phone being deleted
  if (!cleanTargetPhone || cleanTargetPhone === activeStorePhone) {
    store.chats = {};
    store.messages = {};
    store.contacts = {};
  }

  // 2. Delete ONLY the specific store file
  const baseDir = getAuthDir();
  const dirsToClean = Array.from(new Set([baseDir, process.cwd()]));

  const storeFileName = cleanTargetPhone ? `whatsapp_store_${cleanTargetPhone}.json` : "whatsapp_store.json";
  for (const cleanDir of dirsToClean) {
    const fullPath = path.join(cleanDir, storeFileName);
    try {
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
        console.log(`Deleted store file successfully: ${fullPath}`);
      }
    } catch (err) {
      console.error(`Failed to delete store file ${fullPath}:`, err);
    }
  }

  const isActiveSession = !cleanTargetPhone || cleanTargetPhone === activeStorePhone;

  // Clear activeStorePhone variable if it matches the target
  if (activeStorePhone && (!cleanTargetPhone || cleanTargetPhone === activeStorePhone)) {
    activeStorePhone = null;
  }

  // 3. Delete BOTH the specific phone folder AND the legacy auth_info_baileys folder
  // to ensure completely fresh start for new logins / scans.
  const authFoldersToClean = ["auth_info_baileys"];
  if (cleanTargetPhone) {
    authFoldersToClean.push(`auth_info_baileys_${cleanTargetPhone}`);
  }

  for (const cleanDir of dirsToClean) {
    for (const folderName of authFoldersToClean) {
      const fullPath = path.join(cleanDir, folderName);
      try {
        if (fs.existsSync(fullPath)) {
          if (fs.statSync(fullPath).isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
            console.log(`Auth credentials folder deleted successfully: ${fullPath}`);
          }
        }
      } catch (err) {
        console.error(`Failed to delete auth folder ${fullPath}:`, err);
      }
    }
  }

  // 4. Notify all clients with empty states only if the active session was the one disconnected
  if (isActiveSession) {
    broadcastToAll("whatsapp-status", "disconnected");
    broadcastToAll("whatsapp:chats-loaded", []);
    broadcastToAll("whatsapp-history", { contacts: [], chats: {} });
    broadcastToAll("whatsapp-user-profile", null);
    broadcastToAll("whatsapp:my-profile", null);
  }
}

const mapMessage = (msg: any, mediaUrl?: string): any => {
  if (!msg.message) return null;

  const id = msg.key.id;
  const isMe = msg.key.fromMe;
  const jid = msg.key.remoteJid;

  const timestampInSecs = msg.messageTimestamp;
  const timestamp = timestampInSecs ? formatTimestamp(Number(timestampInSecs)) : getCurrentFormattedTime();

  let type: any = "text";
  let text = "";
  let fileUrl = "";
  let fileName = "";
  let fileSize = "";

  // Unpack nested messages (critical for modern WhatsApp features)
  let messageContent = msg.message;
  if (messageContent) {
    const keys = Object.keys(messageContent);
    const outerType = keys[0];
    if (outerType === "viewOnceMessage" || outerType === "viewOnceMessageV2") {
      messageContent = messageContent[outerType]?.message || messageContent;
    } else if (outerType === "documentWithCaptionMessage") {
      messageContent = messageContent[outerType]?.message || messageContent;
    }
  }

  if (messageContent.conversation) {
    text = messageContent.conversation;
  } else if (messageContent.extendedTextMessage) {
    text = messageContent.extendedTextMessage.text || "";
  } else if (messageContent.imageMessage) {
    type = "image";
    text = messageContent.imageMessage.caption || "Photo";
    fileUrl = `/api/chat/get-media?chatJid=${encodeURIComponent(jid)}&msgId=${encodeURIComponent(id)}`;
    fileName = "photo.jpg";
    fileSize = messageContent.imageMessage.fileLength ? `${(Number(messageContent.imageMessage.fileLength) / 1024).toFixed(0)} KB` : "150 KB";
  } else if (messageContent.videoMessage) {
    type = "video";
    text = messageContent.videoMessage.caption || "Video clip";
    fileUrl = `/api/chat/get-media?chatJid=${encodeURIComponent(jid)}&msgId=${encodeURIComponent(id)}`;
    fileName = "video.mp4";
    fileSize = messageContent.videoMessage.fileLength ? `${(Number(messageContent.videoMessage.fileLength) / 1024).toFixed(0)} KB` : "1.2 MB";
  } else if (messageContent.audioMessage) {
    type = messageContent.audioMessage.ptt ? "voice" : "file";
    text = messageContent.audioMessage.ptt ? "Voice Message" : "Audio Message";
    fileUrl = `/api/chat/get-media?chatJid=${encodeURIComponent(jid)}&msgId=${encodeURIComponent(id)}`;
    fileName = messageContent.audioMessage.ptt ? "voice_note.ogg" : "audio.mp3";
    fileSize = messageContent.audioMessage.fileLength ? `${(Number(messageContent.audioMessage.fileLength) / 1024).toFixed(0)} KB` : "45 KB";
  } else if (messageContent.documentMessage) {
    type = "file";
    text = messageContent.documentMessage.fileName || "Document";
    fileName = messageContent.documentMessage.fileName || "Document.pdf";
    fileUrl = `/api/chat/get-media?chatJid=${encodeURIComponent(jid)}&msgId=${encodeURIComponent(id)}`;
    fileSize = messageContent.documentMessage.fileLength ? `${(Number(messageContent.documentMessage.fileLength) / 1024).toFixed(0)} KB` : "14 KB";
  } else if (messageContent.stickerMessage) {
    type = "sticker";
    text = "Sticker";
    fileUrl = `/api/chat/get-media?chatJid=${encodeURIComponent(jid)}&msgId=${encodeURIComponent(id)}`;
  } else {
    return null;
  }

  return {
    id,
    sender: isMe ? "me" : "them",
    text,
    timestamp,
    timestampSecs: Number(timestampInSecs || 0),
    type,
    status: "read",
    fileName,
    fileSize,
    fileUrl: mediaUrl || fileUrl,
  };
};

// ==========================================
// Firebase Firestore Cloud Backup & Restore
// ==========================================
function sanitizeForFirestore(obj: any): any {
  if (obj === undefined || obj === null) return null;
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForFirestore(item));
  }
  
  if (typeof obj === "object") {
    // If it has a toJSON method (like custom classes), call it first to convert to plain object/primitive
    if (typeof obj.toJSON === "function") {
      try {
        return sanitizeForFirestore(obj.toJSON());
      } catch (e) {
        // Fallback if toJSON fails
      }
    }
    
    // If it's a date, convert to string
    if (obj instanceof Date) {
      return obj.toISOString();
    }
    
    // Convert any custom classes/prototypes to plain objects with enumerable keys
    const plainObj: any = {};
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val !== undefined) {
        plainObj[key] = sanitizeForFirestore(val);
      }
    }
    return plainObj;
  }
  
  return obj;
}

async function saveLastActivePhoneToFirestore(phone: string) {
  if (!firestoreDb || !phone) return;
  try {
    console.log(`[Firebase State] Saving last active phone in metadata: ${phone}`);
    await firestoreDb.collection("metadata").doc("globalState").set({
      lastActivePhone: phone,
      updatedAt: new Date().toISOString()
    }, { merge: true });
  } catch (err) {
    console.error("[Firebase State] Error saving last active phone to Firestore:", err);
  }
}

async function getLastActivePhoneFromFirestore(): Promise<string | null> {
  if (!firestoreDb) return null;
  try {
    const doc = await firestoreDb.collection("metadata").doc("globalState").get();
    if (doc.exists) {
      const data = doc.data();
      return data?.lastActivePhone || null;
    }
  } catch (err) {
    console.error("[Firebase State] Error getting last active phone from Firestore:", err);
  }
  return null;
}

async function restoreCredentialsFromFirestore(phone: string): Promise<boolean> {
  if (!firestoreDb || !phone) return false;
  try {
    const baseAuthDir = getAuthDir();
    const authFolderName = `auth_info_baileys_${phone}`;
    const authFolder = path.join(baseAuthDir, authFolderName);
    
    console.log(`[Firebase Restore] Restoring credentials for ${phone} from cloud to ${authFolder}...`);
    
    const accountRef = firestoreDb.collection("accounts").doc(phone);
    const credsSnapshot = await accountRef.collection("credentials").get();
    
    if (credsSnapshot.empty) {
      console.log(`[Firebase Restore] No credentials found in Firestore for ${phone}.`);
      return false;
    }
    
    if (!fs.existsSync(authFolder)) {
      fs.mkdirSync(authFolder, { recursive: true });
    }
    
    let restoredCount = 0;
    credsSnapshot.forEach((d: any) => {
      const fileName = d.id;
      const filePath = path.join(authFolder, fileName);
      const data = d.data();
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
      restoredCount++;
    });
    
    console.log(`[Firebase Restore] Successfully restored ${restoredCount} credentials files for ${phone}.`);
    return true;
  } catch (err) {
    console.error("[Firebase Restore] Failed to restore credentials from Firestore:", err);
    return false;
  }
}

async function backupToFirestore() {
  if (!firestoreDb || !activeStorePhone) return;
  const phone = activeStorePhone;
  try {
    console.log(`[Firebase Backup] Starting cloud backup for account: ${phone}`);
    
    const accountRef = firestoreDb.collection("accounts").doc(phone);

    // 1. Backup chats (recursively sanitized)
    for (const [jid, chat] of Object.entries(store.chats)) {
      if (!jid || !chat) continue;
      const safeDocId = jid.replace(/\//g, "_");
      const chatRef = accountRef.collection("chats").doc(safeDocId);
      const sanitized = sanitizeForFirestore(chat);
      if (sanitized) {
        await chatRef.set(sanitized, { merge: true });
      }
    }
    
    // 2. Backup contacts (recursively sanitized)
    for (const [jid, contact] of Object.entries(store.contacts)) {
      if (!jid || !contact) continue;
      const safeDocId = jid.replace(/\//g, "_");
      const contactRef = accountRef.collection("contacts").doc(safeDocId);
      const sanitized = sanitizeForFirestore(contact);
      if (sanitized) {
        await contactRef.set(sanitized, { merge: true });
      }
    }
    
    // 3. Backup messages (save last 200 per JID, recursively sanitized)
    for (const [jid, msgs] of Object.entries(store.messages)) {
      if (!jid || !msgs || msgs.length === 0) continue;
      const safeDocId = jid.replace(/\//g, "_");
      const lastMsgs = msgs.slice(-200);
      const msgDocRef = accountRef.collection("messages").doc(safeDocId);
      const sanitized = sanitizeForFirestore(lastMsgs);
      if (sanitized) {
        await msgDocRef.set({ messages: sanitized });
      }
    }

    // 4. Backup auth credentials folder (so sessions can auto-heal/survive on Render)
    const baseAuthDir = getAuthDir();
    const authFolderName = `auth_info_baileys_${phone}`;
    const authFolder = path.join(baseAuthDir, authFolderName);
    if (fs.existsSync(authFolder)) {
      const files = fs.readdirSync(authFolder);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const filePath = path.join(authFolder, file);
          try {
            const content = fs.readFileSync(filePath, "utf8");
            const parsed = JSON.parse(content);
            const safeDocId = file.replace(/\//g, "_");
            const credRef = accountRef.collection("credentials").doc(safeDocId);
            const sanitizedParsed = sanitizeForFirestore(parsed);
            if (sanitizedParsed) {
              await credRef.set(sanitizedParsed);
            }
          } catch (fileErr) {
            console.error(`[Firebase Backup] Failed to backup credentials file ${file}:`, fileErr);
          }
        }
      }
    }
    
    console.log(`[Firebase Backup] Cloud backup successfully updated for ${phone}.`);
  } catch (err: any) {
    console.error("[Firebase Backup] Error backing up to Firestore:", err);
  }
}

async function restoreFromFirestore(phone: string) {
  if (!firestoreDb) return;
  try {
    console.log(`[Firebase Restore] Restoring chats, contacts, and messages for ${phone} from cloud...`);
    
    let loadedChats = 0;
    let loadedContacts = 0;
    let loadedMessages = 0;

    const accountRef = firestoreDb.collection("accounts").doc(phone);

    // 1. Restore chats
    const chatsSnapshot = await accountRef.collection("chats").get();
    chatsSnapshot.forEach((d: any) => {
      const originalJid = d.id.replace(/_/g, "/");
      store.chats[originalJid] = d.data();
      loadedChats++;
    });
    
    // 2. Restore contacts
    const contactsSnapshot = await accountRef.collection("contacts").get();
    contactsSnapshot.forEach((d: any) => {
      const originalJid = d.id.replace(/_/g, "/");
      store.contacts[originalJid] = d.data();
      loadedContacts++;
    });
    
    // 3. Restore messages
    const messagesSnapshot = await accountRef.collection("messages").get();
    messagesSnapshot.forEach((d: any) => {
      const originalJid = d.id.replace(/_/g, "/");
      const data = d.data();
      if (data && Array.isArray(data.messages)) {
        store.messages[originalJid] = data.messages;
        loadedMessages++;
      }
    });
    
    console.log(`[Firebase Restore] Restored: ${loadedChats} chats, ${loadedContacts} contacts, ${loadedMessages} message histories.`);
    
    // Broadcast latest data back to active clients so they update immediately!
    broadcastToAll("action:chats-update", store.chats);
    broadcastToAll("action:contacts-update", Object.values(store.contacts));
    
    // Also notify active messages update if any
    const updatedMergedContacts = getMergedContacts();
    broadcastToAll("contacts", updatedMergedContacts);
    broadcastToAll("whatsapp:chats-loaded", updatedMergedContacts);
    
    // Map and broadcast active chats
    const mappedChats: Record<string, any[]> = {};
    for (const jid of Object.keys(store.messages)) {
      const sortedHistory = [...(store.messages[jid] || [])].sort((a, b) => {
        return Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0);
      });
      mappedChats[jid] = sortedHistory
        .map((m) => mapMessage(m))
        .filter(Boolean);
    }
    broadcastToAll("chats", mappedChats);
    broadcastToAll("whatsapp-history", { contacts: updatedMergedContacts, chats: mappedChats });
    
  } catch (err: any) {
    console.error("[Firebase Restore] Error restoring from Firestore:", err);
  }
}

async function deleteAccountFromFirestore(phone: string) {
  if (!firestoreDb || !phone) return;
  try {
    console.log(`[Firebase Delete] Starting full Firestore cleanup for account: ${phone}`);
    const accountRef = firestoreDb.collection("accounts").doc(phone);
    
    // 1. Delete chats
    const chatsSnapshot = await accountRef.collection("chats").get();
    for (const d of chatsSnapshot.docs) {
      await accountRef.collection("chats").doc(d.id).delete();
    }
    console.log(`[Firebase Delete] Deleted ${chatsSnapshot.size} chats from Firestore.`);

    // 2. Delete contacts
    const contactsSnapshot = await accountRef.collection("contacts").get();
    for (const d of contactsSnapshot.docs) {
      await accountRef.collection("contacts").doc(d.id).delete();
    }
    console.log(`[Firebase Delete] Deleted ${contactsSnapshot.size} contacts from Firestore.`);

    // 2.5 Delete credentials
    const credsSnapshot = await accountRef.collection("credentials").get();
    for (const d of credsSnapshot.docs) {
      await accountRef.collection("credentials").doc(d.id).delete();
    }
    console.log(`[Firebase Delete] Deleted ${credsSnapshot.size} credentials from Firestore.`);

    // 3. Delete messages
    const messagesSnapshot = await accountRef.collection("messages").get();
    for (const d of messagesSnapshot.docs) {
      await accountRef.collection("messages").doc(d.id).delete();
    }
    console.log(`[Firebase Delete] Deleted ${messagesSnapshot.size} messages from Firestore.`);

    // 4. Delete the parent account document itself if any
    await accountRef.delete();
    
    // 5. Delete metadata if it's the current active phone
    const lastActive = await getLastActivePhoneFromFirestore();
    if (lastActive === phone) {
      await firestoreDb.collection("metadata").doc("globalState").delete().catch(() => {});
    }
    
    console.log(`[Firebase Delete] Firestore cleanup completed successfully for ${phone}.`);
  } catch (err: any) {
    console.error("[Firebase Delete] Error deleting account data from Firestore:", err);
  }
}

async function deleteAccountFromStorage(phone: string) {
  if (!storageBucket || !phone) return;
  try {
    console.log(`[Firebase Storage Delete] Listing and deleting all files for account: ${phone}`);
    await storageBucket.deleteFiles({
      prefix: `whatsapp_media/${phone}/`
    });
    console.log(`[Firebase Storage Delete] Firebase Storage cleanup completed successfully for ${phone}.`);
  } catch (err: any) {
    console.warn("[Firebase Storage Delete] Storage cleanup skipped (bucket may be uninitialized or inaccessible):", err.message || err);
  }
}

async function connectToWhatsApp(phoneNumber?: string) {
  clearPairingCodeRefresh();
  
  let cleanPhone = "";
  if (phoneNumber) {
    cleanPhone = sanitizeWhatsAppPhone(phoneNumber);
    currentPairingPhoneNumber = cleanPhone;
  } else if (activeStorePhone) {
    cleanPhone = sanitizeWhatsAppPhone(activeStorePhone);
    currentPairingPhoneNumber = cleanPhone;
  } else if (currentPairingPhoneNumber) {
    cleanPhone = sanitizeWhatsAppPhone(currentPairingPhoneNumber);
  }

  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  // If a phoneNumber is provided, we are explicitly triggering a new pairing request for a client.
  // We MUST close any active socket, clear listeners to avoid reconnection triggers, and reset state.
  if (phoneNumber) {
    console.log(`Explicit request to pair/connect phone number: ${cleanPhone}. Forcing close of any existing session.`);
    try {
      if (sock) {
        if (sock.ev && typeof sock.ev.removeAllListeners === "function") {
          sock.ev.removeAllListeners("connection.update");
          sock.ev.removeAllListeners("creds.update");
          sock.ev.removeAllListeners("messaging-history.set");
          sock.ev.removeAllListeners("messages.upsert");
        }
        if (typeof sock.end === "function") {
          sock.end(undefined);
        }
      }
    } catch (err) {
      console.warn("Could not end existing socket cleanly:", err);
    }
    sock = null;
  } else {
    // Normal startup or reconnect logic
    if (sock && (whatsappStatus === "connecting" || whatsappStatus === "connected")) {
      console.log("WhatsApp is already connecting or connected.");
      return;
    }
  }

  whatsappStatus = "connecting";
  qrCodeData = null;
  pairingCode = "";
  whatsappError = null;
  broadcastToAll("whatsapp-status", "connecting");

  try {
    const baseAuthDir = getAuthDir();
    // Dynamically isolate auth folder based on clean phone number, with fallback to legacy 'auth_info_baileys'
    const authFolderName = cleanPhone ? `auth_info_baileys_${cleanPhone}` : "auth_info_baileys";
    const authFolder = path.join(baseAuthDir, authFolderName);

    // Clear existing dynamic authFolder to start a fresh pairing session and trigger the "Enter code to link new device" push notification
    if (phoneNumber) {
      try {
        if (fs.existsSync(authFolder)) {
          fs.rmSync(authFolder, { recursive: true, force: true });
          console.log(`Cleared existing isolated authFolder "${authFolderName}" to start a fresh pairing session for: ${cleanPhone}`);
        }
      } catch (err) {
        console.error("Error clearing isolated authFolder:", err);
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const makeSocketFn = typeof makeWASocket === "function" ? makeWASocket : (makeWASocket as any).default;

    // Clean up previous event listeners on old socket if it exists
    if (sock) {
      try {
        if (sock.ev && typeof sock.ev.removeAllListeners === "function") {
          sock.ev.removeAllListeners("connection.update");
          sock.ev.removeAllListeners("creds.update");
          sock.ev.removeAllListeners("messaging-history.set");
          sock.ev.removeAllListeners("messages.upsert");
        }
      } catch (err) {
        console.warn("Could not clean up old socket listeners:", err);
      }
    }

    const silentLogger = {
      level: "silent",
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      trace: () => {},
      child: () => silentLogger,
    } as any;

    sock = makeSocketFn({
      auth: state,
      printQRInTerminal: false,
      syncFullHistory: true,
      maxChatSignallingMessages: 100,
      connectTimeoutMs: 60000,
      emitOwnEvents: true,
      logger: silentLogger,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      shouldSyncHistoryMessage: (msg: any) => {
        console.log(`[Sync Progress]: ${msg.progress}% of old messages downloaded`);
        broadcastToAll("sync_progress", { progress: msg.progress });
        broadcastToAll("whatsapp:sync-progress", {
          progress: msg.progress,
          action: `পুরনো চ্যাট ইতিহাস ডাউনলোড হচ্ছে (${msg.progress}%)`,
          status: "syncing"
        });
        return true;
      }
    });

    sock.ev.on("creds.update", saveCreds);

    if (phoneNumber && !sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          console.log(`Requesting pairing code for phone: ${cleanPhone}`);
          const code = await sock.requestPairingCode(cleanPhone);
          console.log(`Pairing code received successfully for ${cleanPhone}: ${code}`);
          pairingCode = code;
          whatsappStatus = "pairing-code-ready";
          broadcastToAll("whatsapp-status", "pairing-code-ready");
          
          // Emit both target phoneNumber and code in the broadcast object!
          broadcastToAll("whatsapp-pairing-code", { phoneNumber: cleanPhone, code });

          // Auto-refresh the pairing code every 110 seconds to keep it valid and active
          clearPairingCodeRefresh();
          pairingCodeRefreshTimeout = setTimeout(() => {
            if (whatsappStatus === "pairing-code-ready" && currentPairingPhoneNumber) {
              console.log(`[Auto-Refresh] Pairing code expired. Automatically regenerating for phone: ${currentPairingPhoneNumber}`);
              connectToWhatsApp(currentPairingPhoneNumber);
            }
          }, 110 * 1000);
        } catch (err: any) {
          console.error("Failed to request pairing code:", err);
          whatsappError = `Failed to generate pairing code: ${err.message}`;
          whatsappStatus = "disconnected";
          broadcastToAll("whatsapp-error", whatsappError);
          broadcastToAll("whatsapp-status", "disconnected");
        }
      }, 3000);
    }

    sock.ev.on("connection.update", async (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !phoneNumber) {
        try {
          const qrImage = await QRCode.toDataURL(qr);
          qrCodeData = qrImage;
          whatsappStatus = "qr-ready";
          broadcastToAll("whatsapp-status", "qr-ready");
          broadcastToAll("whatsapp-qr", qrImage);
        } catch (err: any) {
          console.error("QR Code generation error:", err);
        }
      }

      if (connection === "close") {
        const targetPhone = activeStorePhone || (connectedUser ? (connectedUser as any).phoneNumber : null);
        const error = lastDisconnect?.error;
        let reason = error?.output?.statusCode ?? error?.code ?? error?.statusCode;

        const isIntentionalLogout = 
          reason === DisconnectReason.loggedOut || 
          error?.message === "Intentional Logout" || 
          (error?.stack && error.stack.includes("Intentional Logout")) ||
          (error?.message && error.message.includes("logout")) ||
          reason === 401;

        if (isIntentionalLogout) {
          reason = DisconnectReason.loggedOut;
          console.log(`WhatsApp connection closed cleanly (intentional logout).`);
        } else {
          console.log(`WhatsApp connection closed. Reason/StatusCode: ${reason}.`);
        }

        // Set previous socket reference to null as it is closed
        sock = null;

        let shouldReconnect = true;
        let shouldClearCreds = false;

        if (reason === DisconnectReason.loggedOut) {
          console.log("Logged out from WhatsApp. Clearing credentials...");
          shouldReconnect = false;
          shouldClearCreds = true;
        } else if (reason === DisconnectReason.badSession) {
          console.log("Bad session. Clearing credentials and requiring re-pairing...");
          shouldReconnect = false;
          shouldClearCreds = true;
          broadcastToAll("whatsapp-error", "WhatsApp session is corrupted or invalid. Please link your device again.");
        } else if (reason === DisconnectReason.connectionReplaced) {
          console.log("Connection replaced (opened in another session/tab). Disconnecting to avoid conflict loops.");
          shouldReconnect = false;
          broadcastToAll("whatsapp-error", "Connection replaced. Opened in another window/device.");
        } else if (reason === DisconnectReason.restartRequired || reason === 515) {
          console.log("Restart required. Reconnecting immediately...");
          shouldReconnect = true;
        } else {
          console.log(`Temporary disconnect (reason code: ${reason}). Will attempt reconnection in 5s...`);
          shouldReconnect = true;
        }

        if (shouldReconnect) {
          whatsappStatus = "connecting";
          qrCodeData = null;
          pairingCode = "";
          // Keep connectedUser in memory to prevent the frontend from resetting back to the mock screen
          broadcastToAll("whatsapp-status", "connecting");

          if (reconnectTimeout) clearTimeout(reconnectTimeout);
          
          const delay = (reason === DisconnectReason.restartRequired || reason === 515) ? 500 : 5000;
          reconnectTimeout = setTimeout(() => {
            console.log("Attempting automatic WhatsApp reconnection...");
            connectToWhatsApp();
          }, delay);
        } else {
          whatsappStatus = "disconnected";
          qrCodeData = null;
          pairingCode = "";
          connectedUser = null;
          broadcastToAll("whatsapp-status", "disconnected");
        }

        if (shouldClearCreds) {
          clearSessionAndStoreData(targetPhone || undefined);
        }
      } else if (connection === "open") {
        console.log("WhatsApp successfully connected!");
        whatsappStatus = "connected";
        clearPairingCodeRefresh();
        currentPairingPhoneNumber = "";
        
        let myName = sock.user?.name || (sock.authState?.creds?.me as any)?.name || "Connected User";
        const myJid = sock.user?.id?.split(":")[0] + "@s.whatsapp.net" || sock.user?.id;
        const myPhone = sock.user?.id?.split(":")[0] || "";

        // DYNAMICALLY LOAD THE STORE FOR THIS SPECIFIC PHONE NUMBER!
        loadStore(myPhone);

        // Save last active phone to Firestore for container auto-healing / session persistence
        saveLastActivePhoneToFirestore(myPhone);

        let myPic = null;
        try {
          myPic = await sock.profilePictureUrl(myJid, "image").catch(() => null);
        } catch (e) {}

        connectedUser = {
          id: sock.user?.id,
          name: myName,
          phoneNumber: myPhone,
          imgUrl: myPic,
        };
        broadcastToAll("whatsapp-status", "connected");
        broadcastToAll("user-info", connectedUser);
        broadcastToAll("whatsapp:my-profile", { name: myName, id: myJid, imgUrl: myPic });

        // Broadcast the correct isolated chats/history to frontend
        const mergedContacts = getMergedContacts();
        const mappedChats: Record<string, any[]> = {};
        for (const jid of Object.keys(store.messages)) {
          mappedChats[jid] = store.messages[jid]
            .map((m) => mapMessage(m))
            .filter(Boolean);
        }
        broadcastToAll("whatsapp:chats-loaded", mergedContacts);
        broadcastToAll("whatsapp-history", { contacts: mergedContacts, chats: mappedChats });

        // Trigger history sync in background
        runBackgroundHistorySync();
      }
    });

    // Listen for new chats or changes to chat lists (pins, unread count, timestamps)
    sock.ev.on("chats.upsert", (chats: any) => {
      let changed = false;
      for (const chat of chats) {
        const jid = chat.id;
        if (!jid) continue;
        if (!store.chats[jid]) {
          store.chats[jid] = chat;
          changed = true;
        } else {
          store.chats[jid] = { ...store.chats[jid], ...chat };
          changed = true;
        }
        if (chat.pnJid) {
          if (!store.contacts[jid]) {
            store.contacts[jid] = { id: jid };
          }
          if (store.contacts[jid].pnJid !== chat.pnJid) {
            store.contacts[jid].pnJid = chat.pnJid;
            changed = true;
          }
        }
      }
      if (changed) {
        saveStore();
        const mergedContacts = getMergedContacts();
        broadcastToAll("whatsapp:chats-loaded", mergedContacts);
        
        // Also broadcast updated history sorting and details
        const mappedChats: Record<string, any[]> = {};
        for (const jid of Object.keys(store.messages)) {
          mappedChats[jid] = store.messages[jid]
            .map((m) => mapMessage(m))
            .filter(Boolean);
        }
        broadcastToAll("whatsapp-history", { contacts: mergedContacts, chats: mappedChats });
      }
    });

    sock.ev.on("chats.update", (updates: any) => {
      let changed = false;
      for (const update of updates) {
        const jid = update.id;
        if (!jid) continue;
        if (store.chats[jid]) {
          store.chats[jid] = { ...store.chats[jid], ...update };
          changed = true;
        } else {
          store.chats[jid] = update;
          changed = true;
        }
        if (update.pnJid) {
          if (!store.contacts[jid]) {
            store.contacts[jid] = { id: jid };
          }
          if (store.contacts[jid].pnJid !== update.pnJid) {
            store.contacts[jid].pnJid = update.pnJid;
            changed = true;
          }
        }
      }
      if (changed) {
        saveStore();
        const mergedContacts = getMergedContacts();
        broadcastToAll("whatsapp:chats-loaded", mergedContacts);
        
        const mappedChats: Record<string, any[]> = {};
        for (const jid of Object.keys(store.messages)) {
          mappedChats[jid] = store.messages[jid]
            .map((m) => mapMessage(m))
            .filter(Boolean);
        }
        broadcastToAll("whatsapp-history", { contacts: mergedContacts, chats: mappedChats });
      }
    });

    sock.ev.on("chats.delete", (deletes: string[]) => {
      let changed = false;
      for (const jid of deletes) {
        if (store.chats[jid]) {
          delete store.chats[jid];
          changed = true;
        }
      }
      if (changed) {
        saveStore();
        const mergedContacts = getMergedContacts();
        broadcastToAll("whatsapp:chats-loaded", mergedContacts);
        
        const mappedChats: Record<string, any[]> = {};
        for (const jid of Object.keys(store.messages)) {
          mappedChats[jid] = store.messages[jid]
            .map((m) => mapMessage(m))
            .filter(Boolean);
        }
        broadcastToAll("whatsapp-history", { contacts: mergedContacts, chats: mappedChats });
      }
    });

    // Listen for contacts synced from WhatsApp (phonebook names)
    sock.ev.on("contacts.upsert", (contacts: any) => {
      let changed = false;
      for (const contact of contacts) {
        const jid = contact.id;
        if (!jid) continue;
        if (!store.contacts[jid]) {
          store.contacts[jid] = { id: jid };
          changed = true;
        }
        if (contact.pnJid && store.contacts[jid].pnJid !== contact.pnJid) {
          store.contacts[jid].pnJid = contact.pnJid;
          changed = true;
        }
        if (contact.name && store.contacts[jid].savedName !== contact.name) {
          store.contacts[jid].savedName = contact.name;
          changed = true;
        }
        if (contact.notify && store.contacts[jid].notify !== contact.notify) {
          store.contacts[jid].notify = contact.notify;
          changed = true;
        }
        const nameVal = contact.name || contact.notify || contact.verifiedName;
        if (nameVal && store.contacts[jid].name !== nameVal) {
          store.contacts[jid].name = nameVal;
          changed = true;
        }
      }
      if (changed) {
        saveStore();
        contacts.forEach((contact: any) => {
          if (contact.id && store.contacts[contact.id]) {
            broadcastToAll("whatsapp:chat-profile-ready", { jid: contact.id, profile: store.contacts[contact.id] });
          }
        });
      }
    });

    sock.ev.on("contacts.update", (updates: any) => {
      let changed = false;
      for (const update of updates) {
        const jid = update.id;
        if (!jid) continue;
        if (!store.contacts[jid]) {
          store.contacts[jid] = { id: jid };
          changed = true;
        }
        if (update.pnJid && store.contacts[jid].pnJid !== update.pnJid) {
          store.contacts[jid].pnJid = update.pnJid;
          changed = true;
        }
        if (update.name) {
          if (store.contacts[jid].savedName !== update.name) {
            store.contacts[jid].savedName = update.name;
            changed = true;
          }
          if (store.contacts[jid].name !== update.name) {
            store.contacts[jid].name = update.name;
            changed = true;
          }
        }
        if (update.notify) {
          if (store.contacts[jid].notify !== update.notify) {
            store.contacts[jid].notify = update.notify;
            changed = true;
          }
        }
        if (update.verifiedName && store.contacts[jid].name !== update.verifiedName) {
          store.contacts[jid].name = update.verifiedName;
          changed = true;
        }
        if (update.imgUrl && store.contacts[jid].imgUrl !== update.imgUrl) {
          store.contacts[jid].imgUrl = update.imgUrl;
          changed = true;
        }
      }
      if (changed) {
        saveStore();
        updates.forEach((update: any) => {
          if (update.id && store.contacts[update.id]) {
            broadcastToAll("whatsapp:chat-profile-ready", { jid: update.id, profile: store.contacts[update.id] });
          }
        });
      }
    });

    sock.ev.on("contacts.set", (contacts: any) => {
      console.log(`[contacts.set] Syncing ${contacts?.length || 0} contacts.`);
      let changed = false;
      for (const contact of contacts || []) {
        const jid = contact.id;
        if (!jid) continue;
        if (!store.contacts[jid]) {
          store.contacts[jid] = { id: jid };
          changed = true;
        }
        if (contact.name && store.contacts[jid].name !== contact.name) {
          store.contacts[jid].name = contact.name;
          store.contacts[jid].savedName = contact.name;
          changed = true;
        }
        if (contact.notify && store.contacts[jid].notify !== contact.notify) {
          store.contacts[jid].notify = contact.notify;
          changed = true;
        }
        if (contact.pnJid && store.contacts[jid].pnJid !== contact.pnJid) {
          store.contacts[jid].pnJid = contact.pnJid;
          changed = true;
        }
      }
      if (changed) {
        saveStore();
        broadcastToAll("whatsapp:chats-loaded", getMergedContacts());
      }
    });

    sock.ev.on("chats.set", (chats: any) => {
      console.log(`[chats.set] Syncing ${chats?.length || 0} chats.`);
      let changed = false;
      for (const chat of chats || []) {
        const jid = chat.id;
        if (!jid) continue;
        if (!store.chats[jid]) {
          store.chats[jid] = chat;
          changed = true;
        } else {
          store.chats[jid] = { ...store.chats[jid], ...chat };
          changed = true;
        }
      }
      if (changed) {
        saveStore();
        broadcastToAll("whatsapp:chats-loaded", getMergedContacts());
      }
    });

    sock.ev.on("messages.set", (messages: any) => {
      console.log(`[messages.set] Syncing ${messages?.length || 0} messages.`);
      let changed = false;
      for (const msg of messages || []) {
        const jid = msg.key?.remoteJid;
        if (!jid) continue;
        if (!store.messages[jid]) store.messages[jid] = [];
        if (!store.messages[jid].some((m) => m.key?.id === msg.key?.id)) {
          store.messages[jid].push(msg);
          changed = true;
        }
      }
      if (changed) {
        saveStore();
        const mergedContacts = getMergedContacts();
        const mappedChats: Record<string, any[]> = {};
        for (const jid of Object.keys(store.messages)) {
          mappedChats[jid] = store.messages[jid]
            .map((m) => mapMessage(m))
            .filter(Boolean);
        }
        broadcastToAll("whatsapp-history", { contacts: mergedContacts, chats: mappedChats });
      }
    });

    sock.ev.on("messaging-history.set", async (history: any) => {
      const { chats = [], messages = [], contacts = [] } = history;
      console.log(`[🚀 BULK SYNC] Syncing History: ${chats.length} chats, ${messages.length} messages, ${contacts.length} contacts found.`);
      
      // নিজের প্রোফাইল তথ্য ফ্রন্টএন্ডে পাঠানো
      if (sock && sock.user) {
        const myJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
        const myPic = await sock.profilePictureUrl(myJid, "image").catch(() => null);
        broadcastToAll("whatsapp:my-profile", { name: sock.user.name, id: myJid, imgUrl: myPic });
      }

      // ১. বাল্ক কন্টাক্ট বুক রাইটিং
      for (const contact of contacts) {
        if (!contact.id) continue;
        if (!store.contacts[contact.id]) {
          store.contacts[contact.id] = { id: contact.id };
        }
        if (contact.pnJid) {
          store.contacts[contact.id].pnJid = contact.pnJid;
        }
        if (contact.name) {
          store.contacts[contact.id].savedName = contact.name;
          store.contacts[contact.id].name = contact.name;
        }
        if (contact.notify) {
          store.contacts[contact.id].notify = contact.notify;
        }
      }

      // ২. বাল্ক চ্যাট রাইটিং
      for (const chat of chats) {
        store.chats[chat.id] = { ...store.chats[chat.id], ...chat };
        if (!store.contacts[chat.id]) {
          store.contacts[chat.id] = { id: chat.id };
        }
        if (chat.pnJid) {
          store.contacts[chat.id].pnJid = chat.pnJid;
        }
        if (chat.name) {
          if (!chat.id.endsWith("@g.us")) {
            store.contacts[chat.id].savedName = chat.name;
          }
          store.contacts[chat.id].name = chat.name || store.contacts[chat.id].name;
        }
        // প্রতিটা বন্ধুর প্রোফাইল পিকচার এবং গ্রুপ নাম ব্যাকগ্রাউন্ডে লোড করা
        getContactInfo(sock, chat.id).then((info) => {
          broadcastToAll("whatsapp:chat-profile-ready", { jid: chat.id, profile: info });
        });
      }

      // ৩. বাল্ক মেসেজ রাইটিং
      for (const msg of messages) {
        const jid = msg.key?.remoteJid;
        if (!jid) continue;
        if (!store.messages[jid]) store.messages[jid] = [];
        if (!store.messages[jid].some((m) => m.key?.id === msg.key?.id)) {
          store.messages[jid].push(msg);
        }

        // কন্টাক্টের পুশ নেম থাকলে তা সেভ করা
        if (msg.pushName) {
          const senderJid = msg.key.fromMe
            ? (sock?.user?.id?.split(":")[0] + "@s.whatsapp.net")
            : (msg.key.participant || jid);
          
          if (senderJid && !senderJid.endsWith("@g.us")) {
            const senderClean = senderJid.split(":")[0] + "@s.whatsapp.net";
            if (!store.contacts[senderClean]) {
              store.contacts[senderClean] = { id: senderClean };
            }
            store.contacts[senderClean].notify = msg.pushName;
          }
        }
      }

      // ⏳ স্পিড বাড়ানোর ট্রিক: প্রতিটা মেসেজে ফাইল সেভ না করে, একসাথে সব প্রসেস শেষে একবার সেভ
      saveStore();

      const mergedContacts = getMergedContacts();
      broadcastToAll("whatsapp:chats-loaded", mergedContacts);

      // ৪. কন্টাক্ট হিস্ট্রি ম্যাপ করা (ক্যালকুলেটেড chronological অর্ডারে)
      const mappedChats: Record<string, any[]> = {};
      
      for (const jid of Object.keys(store.messages)) {
        const sorted = [...store.messages[jid]].sort((a, b) => {
          return Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0);
        });
        mappedChats[jid] = sorted
          .map((m) => mapMessage(m))
          .filter(Boolean);
      }

      broadcastToAll("whatsapp-history", { contacts: mergedContacts, chats: mappedChats });

      // ফ্রন্টএন্ড ওয়েব ক্লায়েন্টকে একবারে পুরো ফ্রেশ ডাটা পাঠিয়ে দেওয়া
      broadcastToAll("bulk_data_synced", {
        chatsCount: Object.keys(store.chats).length,
        messagesCount: messages.length
      });

      console.log(`[✅ SYNC COMPLETED] ওল্ড চ্যাট সফলভাবে সিঙ্ক ও ক্যাশ হয়েছে!`);

      // Trigger our robust background history sync to double-check and resolve all details fully
      runBackgroundHistorySync();
    });

    sock.ev.on("messages.upsert", async (upsert: any) => {
      const { messages, type } = upsert;
      if (type === "notify" || type === "append") {
        for (const msg of messages) {
          const jid = msg.key?.remoteJid;
          if (!jid) continue;
          if (!store.messages[jid]) store.messages[jid] = [];
          if (!store.messages[jid].some((m) => m.key?.id === msg.key?.id)) {
            store.messages[jid].push(msg);
            saveStore();
          }

          // রিয়েল-টাইমে পুশ নেম সেভ করা (গ্রুপ এবং সেলফ রিনেম বাগ মুক্ত)
          if (msg.pushName) {
            const senderJid = msg.key.fromMe
              ? (sock?.user?.id?.split(":")[0] + "@s.whatsapp.net")
              : (msg.key.participant || jid);
            if (senderJid && !senderJid.endsWith("@g.us")) {
              const senderClean = senderJid.split(":")[0] + "@s.whatsapp.net";
              if (!store.contacts[senderClean]) store.contacts[senderClean] = { id: senderClean };
              store.contacts[senderClean].notify = msg.pushName;
              saveStore();
              broadcastToAll("whatsapp:chat-profile-ready", { jid: senderClean, profile: store.contacts[senderClean] });
            }
          }

          // যদি মেসেজে মিডিয়া/ভয়েস থাকে, তা রিয়েল-টাইমে ডাউনলোড করে ফ্রন্টএন্ডে পুশ করা
          let hasMedia = false;
          let messageContent = msg.message;
          if (messageContent) {
            const keys = Object.keys(messageContent);
            const outerType = keys[0];
            if (outerType === "viewOnceMessage" || outerType === "viewOnceMessageV2") {
              messageContent = messageContent[outerType]?.message || messageContent;
            } else if (outerType === "documentWithCaptionMessage") {
              messageContent = messageContent[outerType]?.message || messageContent;
            }
            hasMedia = !!(
              messageContent?.imageMessage || 
              messageContent?.audioMessage || 
              messageContent?.videoMessage || 
              messageContent?.documentMessage ||
              messageContent?.stickerMessage
            );
          }

          let decryptedMedia = null;
          if (hasMedia) {
            decryptedMedia = await downloadMediaMessage(msg);
          }

          const mapped = mapMessage(msg, decryptedMedia);
          if (mapped) {
            broadcastToAll("whatsapp-message-new", { jid, message: mapped });
          }

          broadcastToAll("whatsapp:new-message", {
            jid,
            message: msg,
            mediaUrl: decryptedMedia,
          });
        }
      }
    });

  } catch (err: any) {
    console.error("Error in Baileys startup:", err);
    whatsappError = err.message || "Unknown error starting Baileys";
    whatsappStatus = "disconnected";
    broadcastToAll("whatsapp-error", whatsappError);
    broadcastToAll("whatsapp-status", "disconnected");
  }
}

// Auto-reconnect on server startup if credentials exist (with cross-instance automatic cloud restore support)
async function handleStartupAutoConnection() {
  let startupFolder: string | null = null;
  let foundPhone: string = "";
  const baseAuthDir = getAuthDir();

  try {
    if (fs.existsSync(baseAuthDir)) {
      const files = fs.readdirSync(baseAuthDir);
      for (const file of files) {
        if (file === "auth_info_baileys" || file.startsWith("auth_info_baileys_")) {
          const credsPath = path.join(baseAuthDir, file, "creds.json");
          if (fs.existsSync(credsPath)) {
            startupFolder = file;
            if (file.startsWith("auth_info_baileys_")) {
              foundPhone = file.replace("auth_info_baileys_", "");
            }
            break;
          }
        }
      }
    }
  } catch (e) {
    console.error("Error scanning auth folders on startup:", e);
  }

  if (startupFolder) {
    console.log(`[Startup] Found existing credentials in local auth folder "${startupFolder}". Auto-connecting...`);
    if (foundPhone) {
      currentPairingPhoneNumber = foundPhone;
    }
    connectToWhatsApp();
    return;
  }

  // If no local credentials, check Firestore for cross-instance automatic cloud restore (solves ephemeral Render restarts!)
  if (firestoreDb) {
    try {
      console.log("[Startup] No local credentials found. Checking Firestore for active sessions to restore...");
      const lastPhone = await getLastActivePhoneFromFirestore();
      if (lastPhone) {
        console.log(`[Startup] Found last active phone from Firestore: ${lastPhone}. Restoring session...`);
        const restored = await restoreCredentialsFromFirestore(lastPhone);
        if (restored) {
          console.log(`[Startup] Session credentials restored successfully. Restoring store messages and chats...`);
          currentPairingPhoneNumber = lastPhone;
          // Pre-emptively restore cache
          await restoreFromFirestore(lastPhone);
          // Auto connect
          connectToWhatsApp();
        } else {
          console.log(`[Startup] Cloud credentials restore failed or empty for: ${lastPhone}`);
        }
      } else {
        console.log("[Startup] No previous active session registered in Firestore.");
      }
    } catch (err) {
      console.error("[Startup] Failed during cloud session restore:", err);
    }
  } else {
    console.log("[Startup] Firestore DB is not available. Auto-recovery skipped.");
  }
}

// Trigger startup auto connection
handleStartupAutoConnection();

// Setup Baileys Socket.io Events
io.on("connection", (socket) => {
  console.log("Client connected via Socket.io:", socket.id);
  activeSockets.add(socket);

  // Send current global WhatsApp status and details immediately on connect
  socket.emit("whatsapp-status", whatsappStatus);
  if (connectedUser) socket.emit("user-info", connectedUser);
  if (qrCodeData) socket.emit("whatsapp-qr", qrCodeData);
  if (pairingCode) socket.emit("whatsapp-pairing-code", pairingCode);
  if (whatsappError) socket.emit("whatsapp-error", whatsappError);

  if (whatsappStatus === "connected") {
    // Send my profile if connected
    if (sock && sock.user) {
      const myJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
      sock.profilePictureUrl(myJid, "image")
        .then((myPic: string) => {
          socket.emit("whatsapp:my-profile", { name: sock.user.name, id: myJid, imgUrl: myPic });
        })
        .catch(() => {
          socket.emit("whatsapp:my-profile", { name: sock.user.name, id: myJid, imgUrl: null });
        });
    }

    // Send currently cached history
    const mergedContacts = getMergedContacts();
    const mappedChats: Record<string, any[]> = {};
    for (const jid of Object.keys(store.messages)) {
      mappedChats[jid] = store.messages[jid]
        .map((m) => mapMessage(m))
        .filter(Boolean);
    }
    
    socket.emit("whatsapp:chats-loaded", mergedContacts);
    socket.emit("whatsapp-history", { contacts: mergedContacts, chats: mappedChats });

    // Send profile/status details for each chat contact
    Object.keys(store.chats).forEach((jid) => {
      getContactInfo(sock, jid).then((info) => {
        socket.emit("whatsapp:chat-profile-ready", { jid, profile: info });
      });
    });

    if (!isSyncingHistory && !syncCompletedThisRun) {
      runBackgroundHistorySync();
    }
  }

  // Emit current sync status to the newly connected client
  socket.emit("whatsapp:sync-progress", {
    progress: syncProgress,
    action: syncActionText || (syncCompletedThisRun ? "১০০% সফলভাবে সকল প্রোফাইল ও ইতিহাস লোড হয়েছে!" : "অপেক্ষমান..."),
    status: isSyncingHistory ? "syncing" : (syncCompletedThisRun ? "completed" : "idle")
  });

  socket.on("start-pairing", async (data?: { phoneNumber?: string }) => {
    const rawPhone = data?.phoneNumber || "";
    const phoneNumber = sanitizeWhatsAppPhone(rawPhone);
    connectToWhatsApp(phoneNumber);
  });

  socket.on("delete-client", async (data?: { phoneNumber?: string }) => {
    const rawPhone = data?.phoneNumber || "";
    const cleanPhone = sanitizeWhatsAppPhone(rawPhone);
    if (!cleanPhone) return;

    console.log(`[Delete Client Request] Deleting isolated state folder and resetting any active socket session for phone: ${cleanPhone}`);
    
    // 1. Delete dynamic folder
    const authFolder = path.join(process.cwd(), `auth_info_baileys_${cleanPhone}`);
    try {
      if (fs.existsSync(authFolder)) {
        fs.rmSync(authFolder, { recursive: true, force: true });
        console.log(`Successfully deleted folder on server: ${authFolder}`);
      }
    } catch (err) {
      console.error(`Error deleting folder ${authFolder}:`, err);
    }

    // 2. If it's the current active pairing phone, clear it and end socket
    if (currentPairingPhoneNumber && sanitizeWhatsAppPhone(currentPairingPhoneNumber) === cleanPhone) {
      console.log(`Terminating active pairing session for deleted client: ${cleanPhone}`);
      clearPairingCodeRefresh();
      currentPairingPhoneNumber = "";
      try {
        if (sock) {
          if (sock.ev && typeof sock.ev.removeAllListeners === "function") {
            sock.ev.removeAllListeners("connection.update");
            sock.ev.removeAllListeners("creds.update");
            sock.ev.removeAllListeners("messaging-history.set");
            sock.ev.removeAllListeners("messages.upsert");
          }
          if (typeof sock.end === "function") {
            sock.end(undefined);
          }
        }
      } catch (err) {
        console.warn("Could not end socket cleanly during delete-client:", err);
      }
      sock = null;
      whatsappStatus = "disconnected";
      qrCodeData = null;
      pairingCode = "";
      broadcastToAll("whatsapp-status", "disconnected");
    }
  });

  socket.on("disconnect-whatsapp", async () => {
    console.log("Disconnect and logout requested manually.");
    const targetPhone = activeStorePhone || (connectedUser ? (connectedUser as any).phoneNumber : null);
    clearPairingCodeRefresh();
    currentPairingPhoneNumber = "";
    
    // Clean up event listeners first so Baileys connection.update doesn't try to auto-reconnect or error out
    if (sock) {
      try {
        if (sock.ev && typeof sock.ev.removeAllListeners === "function") {
          sock.ev.removeAllListeners("connection.update");
          sock.ev.removeAllListeners("creds.update");
          sock.ev.removeAllListeners("messaging-history.set");
          sock.ev.removeAllListeners("messages.upsert");
          sock.ev.removeAllListeners("contacts.set");
          sock.ev.removeAllListeners("chats.set");
          sock.ev.removeAllListeners("messages.set");
        }
      } catch (err) {
        console.warn("Could not remove listeners before logout:", err);
      }
    }

    // Call sock.logout() to revoke the session from the WhatsApp server (linked devices option list)
    try {
      if (sock && typeof sock.logout === "function") {
        await sock.logout().catch((e: any) => console.log("baileys logout catch:", e));
      }
    } catch (err) {
      console.error("Error calling sock.logout():", err);
    }

    // End and terminate the socket
    try {
      if (sock && typeof sock.end === "function") {
        sock.end(undefined);
      }
    } catch (err) {
      console.error("Error ending sock connection:", err);
    }

    sock = null;
    whatsappStatus = "disconnected";
    qrCodeData = null;
    pairingCode = "";
    connectedUser = null;
    
    // Clear ALL server-side store files and session folders
    clearSessionAndStoreData(targetPhone || undefined);
    
    // Broadcast status to all frontend clients
    broadcastToAll("whatsapp-status", "disconnected");
  });

  socket.on("send-whatsapp-message", async (data: { contactId: string, text: string }) => {
    if (sock && whatsappStatus === "connected") {
      try {
        console.log(`Sending real-time message via WhatsApp: To: ${data.contactId}, Body: ${data.text}`);
        const sent = await sock.sendMessage(data.contactId, { text: data.text });
        if (!store.messages[data.contactId]) store.messages[data.contactId] = [];
        store.messages[data.contactId].push(sent);
      } catch (err) {
        console.error("Failed to send real-time message via Baileys:", err);
      }
    }
  });

  // ১. কোনো বন্ধুর প্রোফাইলে বা চ্যাটে ক্লিক করলে তার সম্পূর্ণ ডেটা ফ্রন্টএন্ডে পাঠানো
  socket.on("action:click-friend", async (jid: string) => {
    try {
      let imgUrl = null;
      let statusText = "";

      if (sock) {
        imgUrl = await sock.profilePictureUrl(jid, "image").catch(() => null);
        if (sock) {
          const statusData = await sock.fetchStatus(jid).catch(() => null);
          statusText = statusData?.status || "";
        }
      }
      
      if (!store.contacts[jid]) store.contacts[jid] = { id: jid };
      if (imgUrl) store.contacts[jid].imgUrl = imgUrl;
      if (statusText) store.contacts[jid].status = statusText;

      // হোয়াটসঅ্যাপ সার্ভার থেকে চ্যাট হিস্ট্রি রিকোয়েস্ট করা (যদি ক্যাশে না থাকে)
      let history = store.messages[jid] || [];
      if (history.length === 0) {
        if (sock && typeof sock.chatsCompose === "function") {
          await sock.chatsCompose({ jid, count: 30 }).catch((e: any) => console.log("chatsCompose failed:", e.message));
        } else {
          console.log("chatsCompose is not available or not a function on sock");
        }
        history = store.messages[jid] || [];
      }

      // Sort history chronologically (oldest first)
      const sortedHistory = [...history].sort((a, b) => {
        return Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0);
      });

      // ডিক্রিপ্ট করা মিডিয়া সহ মেসেজ লিস্ট পাঠানো
      const enrichedHistory = await enrichHistoryMessages(sortedHistory);

      const contactName = store.contacts[jid]?.name || jid.split("@")[0];

      socket.emit("response:friend-profile-and-chats", {
        jid,
        profile: { imgUrl, status: statusText, id: jid, name: contactName },
        history: enrichedHistory.filter(Boolean),
      });
    } catch (err: any) {
      console.error("Error in action:click-friend:", err);
      socket.emit("action:error", { type: "click-friend", message: err.message });
    }
  });

  // Request full history sync (chats, contacts, messages, profiles)
  socket.on("request:full-history", async () => {
    try {
      console.log(`[Socket] Client requested full history sync. Status: ${whatsappStatus}`);
      
      // Send user info if connected
      if (connectedUser) {
        socket.emit("user-info", connectedUser);
      }
      
      // Send my profile if available
      if (sock && sock.user) {
        const myJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
        const myPic = await sock.profilePictureUrl(myJid, "image").catch(() => null);
        socket.emit("whatsapp:my-profile", { name: sock.user.name, id: myJid, imgUrl: myPic });
      }

      const mergedContacts = getMergedContacts();
      const mappedChats: Record<string, any[]> = {};
      for (const jid of Object.keys(store.messages)) {
        if (store.messages[jid]) {
          mappedChats[jid] = store.messages[jid]
            .map((m) => mapMessage(m))
            .filter(Boolean);
        }
      }
      
      socket.emit("whatsapp:chats-loaded", mergedContacts);
      socket.emit("whatsapp-history", { contacts: mergedContacts, chats: mappedChats });
      console.log(`[Socket] Dispatched ${mergedContacts.length} contacts and ${Object.keys(mappedChats).length} chats to client.`);
    } catch (err: any) {
      console.error("Error handling request:full-history:", err);
    }
  });

  // ১.২. ম্যানুয়ালভাবে পুরো চ্যাট হিস্ট্রি রিলোড বা সিঙ্ক করা
  socket.on("action:reload-chat-history", async ({ jid, count }: { jid: string; count?: number }) => {
    try {
      console.log(`Manually reloading chat history for: ${jid}, count: ${count || 100}`);
      if (!sock) {
        // If not connected, return what we currently have in store
        const history = store.messages[jid] || [];
        const sortedHistory = [...history].sort((a, b) => {
          return Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0);
        });

        const enrichedHistory = await enrichHistoryMessages(sortedHistory);
        socket.emit("response:friend-profile-and-chats", {
          jid,
          history: enrichedHistory.filter(Boolean),
          isReload: true,
        });
        return;
      }

      // If connected, fetch older history via chatsCompose from the connected phone
      const fetchCount = count || 100;
      if (typeof sock.chatsCompose === "function") {
        await sock.chatsCompose({ jid, count: fetchCount }).catch((e: any) => {
          console.log("chatsCompose manual reload failed:", e.message);
        });
      }

      const history = store.messages[jid] || [];
      const sortedHistory = [...history].sort((a, b) => {
        return Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0);
      });

      const enrichedHistory = await enrichHistoryMessages(sortedHistory);

      socket.emit("response:friend-profile-and-chats", {
        jid,
        history: enrichedHistory.filter(Boolean),
        isReload: true,
      });
    } catch (err: any) {
      console.error("Error in action:reload-chat-history:", err);
      socket.emit("action:error", { type: "reload-chat-history", message: err.message });
    }
  });

  // ২. ইনবক্স থেকে টেক্সট মেসেজ পাঠানো
  socket.on("action:send-text", async ({ to, text }: { to: string; text: string }) => {
    try {
      if (!sock) throw new Error("WhatsApp is not connected");
      const sent = await sock.sendMessage(to, { text: text });
      
      if (!store.messages[to]) store.messages[to] = [];
      store.messages[to].push(sent);

      const mapped = mapMessage(sent);
      socket.emit("action:success", { type: "send-text", message: mapped || sent });
      broadcastToAll("whatsapp-message-new", { jid: to, message: mapped });
    } catch (err: any) {
      console.error("Error sending text:", err);
      socket.emit("action:error", { type: "send-text", error: err.message });
    }
  });

  // ৩. রিয়েল টাইম ভয়েস নোট বা মিডিয়া ফাইল পাঠানো (Buffer/Base64 থেকে)
  socket.on("action:send-media", async ({ to, base64Data, type, mimeType }: { to: string; base64Data: string; type: string; mimeType?: string }) => {
    try {
      if (!sock) throw new Error("WhatsApp is not connected");
      
      // Base64 ফাইলকে বাফারে রূপান্তর
      const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
      const buffer = Buffer.from(cleanBase64, "base64");
      let options: any = {};

      if (type === "audio" || type === "voice") {
        options = { audio: buffer, mimetype: mimeType || "audio/mp4", ptt: true }; // ptt: true মানে ভয়েস নোট হিসেবে যাবে
      } else if (type === "image") {
        options = { image: buffer, mimetype: mimeType || "image/jpeg" };
      } else {
        options = { document: buffer, mimetype: mimeType || "application/octet-stream", fileName: "File" };
      }

      const sentMedia = await sock.sendMessage(to, options);
      
      if (!store.messages[to]) store.messages[to] = [];
      store.messages[to].push(sentMedia);

      const mapped = mapMessage(sentMedia);
      
      socket.emit("action:success", { type: "send-media", message: mapped || sentMedia });
      broadcastToAll("whatsapp-message-new", { jid: to, message: mapped });
    } catch (err: any) {
      console.error("Error sending media:", err);
      socket.emit("action:error", { type: "send-media", error: err.message });
    }
  });

  // ৪. নতুন মেসেজ সিন (Seen / Read / Blue Tick) করা
  socket.on("action:seen-chat", async (jid: string) => {
    try {
      if (!sock) return;
      const chatMessages = store.messages[jid] || [];
      if (chatMessages.length > 0) {
        const lastMessage = chatMessages[chatMessages.length - 1];
        await sock.readMessages([lastMessage.key]);
        socket.emit("action:success", { type: "seen-chat", jid });
      }
    } catch (err: any) {
      console.error("Seen/Read error:", err);
    }
  });

  // ৫. কোনো বন্ধুকে আর্কাইভ (Archive) এ নেওয়া বা আর্কাইভ থেকে সরানো
  socket.on("action:archive-chat", async ({ jid, archiveState }: { jid: string; archiveState: boolean }) => {
    try {
      if (sock) {
        const chatMsgs = store.messages[jid] || [];
        const lastMsg = chatMsgs[chatMsgs.length - 1];
        const modification: any = { archive: archiveState };
        if (lastMsg && lastMsg.key) {
          modification.lastMessages = [{
            key: lastMsg.key,
            messageTimestamp: lastMsg.timestampSecs || lastMsg.messageTimestamp
          }];
        }
        await sock.chatModify(modification, jid).catch((e: any) => console.warn("Baileys archive error:", e));
      }
      if (!store.chats[jid]) store.chats[jid] = { id: jid };
      store.chats[jid].archive = archiveState;
      if (store.contacts[jid]) store.contacts[jid].archive = archiveState;
      saveStore();
      
      // Broadcast update to all client sockets in real-time
      broadcastToAll("whatsapp:update-contact", { id: jid, updates: { archive: archiveState } });
      socket.emit("action:success", { type: "archive-chat", jid, archived: archiveState });
    } catch (err: any) {
      console.error("Archive error:", err);
      socket.emit("action:error", { type: "archive-chat", error: err.message });
    }
  });

  // 六. কোনো বন্ধুকে পিন (Pin) এ নেওয়া বা পিন থেকে সরানো
  socket.on("action:pin-chat", async ({ jid, pinState }: { jid: string; pinState: boolean }) => {
    try {
      if (sock) {
        const chatMsgs = store.messages[jid] || [];
        const lastMsg = chatMsgs[chatMsgs.length - 1];
        const modification: any = { pin: pinState };
        if (lastMsg && lastMsg.key) {
          modification.lastMessages = [{
            key: lastMsg.key,
            messageTimestamp: lastMsg.timestampSecs || lastMsg.messageTimestamp
          }];
        }
        await sock.chatModify(modification, jid).catch((e: any) => console.warn("Baileys pin error:", e));
      }
      if (!store.chats[jid]) store.chats[jid] = { id: jid };
      store.chats[jid].isPinned = pinState;
      if (store.contacts[jid]) store.contacts[jid].isPinned = pinState;
      saveStore();

      // Broadcast update to all client sockets in real-time
      broadcastToAll("whatsapp:update-contact", { id: jid, updates: { isPinned: pinState } });
      socket.emit("action:success", { type: "pin-chat", jid, isPinned: pinState });
    } catch (err: any) {
      console.error("Pin error:", err);
      socket.emit("action:error", { type: "pin-chat", error: err.message });
    }
  });

  // ৭. মিউট (Mute) বা আনমিউট (Unmute) করা
  socket.on("action:mute-chat", async ({ jid, muteState, durationMs }: { jid: string; muteState: boolean; durationMs?: number }) => {
    try {
      if (sock) {
        const muteDuration = muteState ? (durationMs || 8 * 60 * 60 * 1000) : null;
        const chatMsgs = store.messages[jid] || [];
        const lastMsg = chatMsgs[chatMsgs.length - 1];
        const modification: any = { mute: muteDuration };
        if (lastMsg && lastMsg.key) {
          modification.lastMessages = [{
            key: lastMsg.key,
            messageTimestamp: lastMsg.timestampSecs || lastMsg.messageTimestamp
          }];
        }
        await sock.chatModify(modification, jid).catch((e: any) => console.warn("Baileys mute error:", e));
      }
      if (!store.chats[jid]) store.chats[jid] = { id: jid };
      store.chats[jid].isMuted = muteState;
      if (store.contacts[jid]) store.contacts[jid].isMuted = muteState;
      saveStore();

      // Broadcast update to all client sockets in real-time
      broadcastToAll("whatsapp:update-contact", { id: jid, updates: { isMuted: muteState } });
      socket.emit("action:success", { type: "mute-chat", jid, isMuted: muteState });
    } catch (err: any) {
      console.error("Mute error:", err);
      socket.emit("action:error", { type: "mute-chat", error: err.message });
    }
  });

  // ৮. মার্ক এজ রিড (Mark as Read) বা আনরিড (Mark as Unread) করা
  socket.on("action:mark-chat-read", async ({ jid, readState }: { jid: string; readState: boolean }) => {
    try {
      if (sock) {
        const chatMsgs = store.messages[jid] || [];
        const lastMsg = chatMsgs[chatMsgs.length - 1];
        const modification: any = { markRead: readState };
        if (lastMsg && lastMsg.key) {
          modification.lastMessages = [{
            key: lastMsg.key,
            messageTimestamp: lastMsg.timestampSecs || lastMsg.messageTimestamp
          }];
        }
        await sock.chatModify(modification, jid).catch((e: any) => console.warn("Baileys markRead error:", e));
      }
      const unreadCount = readState ? 0 : 1;
      if (!store.chats[jid]) store.chats[jid] = { id: jid };
      store.chats[jid].unreadCount = unreadCount;
      if (store.contacts[jid]) store.contacts[jid].unreadCount = unreadCount;
      saveStore();

      // Broadcast update to all client sockets in real-time
      broadcastToAll("whatsapp:update-contact", { id: jid, updates: { unreadCount } });
      socket.emit("action:success", { type: "mark-chat-read", jid, readState });
    } catch (err: any) {
      console.error("Mark read error:", err);
      socket.emit("action:error", { type: "mark-chat-read", error: err.message });
    }
  });

  // ৯. ফেভারিট (Favorite) লিস্টে যুক্ত করা বা সরানো
  socket.on("action:favorite-chat", async ({ jid, isFavorite }: { jid: string; isFavorite: boolean }) => {
    try {
      if (!store.chats[jid]) store.chats[jid] = { id: jid };
      store.chats[jid].isFavorite = isFavorite;
      if (store.contacts[jid]) store.contacts[jid].isFavorite = isFavorite;
      saveStore();

      // Broadcast update to all client sockets in real-time
      broadcastToAll("whatsapp:update-contact", { id: jid, updates: { isFavorite } });
      socket.emit("action:success", { type: "favorite-chat", jid, isFavorite });
    } catch (err: any) {
      console.error("Favorite error:", err);
      socket.emit("action:error", { type: "favorite-chat", error: err.message });
    }
  });

  // ১০. কাস্টম লিস্টে যুক্ত করা
  socket.on("action:add-to-list", async ({ jid, listName }: { jid: string; listName: string }) => {
    try {
      const isFavorite = listName === "Favorites";
      if (!store.chats[jid]) store.chats[jid] = { id: jid };
      if (isFavorite) {
        store.chats[jid].isFavorite = true;
        if (store.contacts[jid]) store.contacts[jid].isFavorite = true;
      }
      const currentCats = store.chats[jid].categories || [];
      if (!currentCats.includes(listName)) {
        currentCats.push(listName);
      }
      store.chats[jid].categories = currentCats;
      if (store.contacts[jid]) store.contacts[jid].categories = currentCats;
      saveStore();

      // Broadcast update to all client sockets in real-time
      broadcastToAll("whatsapp:update-contact", { id: jid, updates: { isFavorite: store.chats[jid].isFavorite, categories: currentCats } });
      socket.emit("action:success", { type: "add-to-list", jid, listName });
    } catch (err: any) {
      console.error("Add to list error:", err);
      socket.emit("action:error", { type: "add-to-list", error: err.message });
    }
  });

  // ১১. ব্লক (Block) বা আনব্লক (Unblock) করা
  socket.on("action:block-contact", async ({ jid, blockState }: { jid: string; blockState: boolean }) => {
    try {
      if (sock) {
        await sock.updateBlockStatus(jid, blockState ? "block" : "unblock").catch((e: any) => console.warn("Baileys block error:", e));
      }
      if (!store.chats[jid]) store.chats[jid] = { id: jid };
      store.chats[jid].isBlocked = blockState;
      if (store.contacts[jid]) store.contacts[jid].isBlocked = blockState;
      saveStore();

      // Broadcast update to all client sockets in real-time
      broadcastToAll("whatsapp:update-contact", { id: jid, updates: { isBlocked: blockState } });
      socket.emit("action:success", { type: "block-contact", jid, isBlocked: blockState });
    } catch (err: any) {
      console.error("Block error:", err);
      socket.emit("action:error", { type: "block-contact", error: err.message });
    }
  });

  // ১২. চ্যাট ক্লিয়ার (Clear Chat) করা
  socket.on("action:clear-chat", async ({ jid }: { jid: string }) => {
    try {
      if (sock) {
        await sock.chatModify({ clear: true }, jid).catch((e: any) => console.warn("Baileys clear error:", e));
      }
      store.messages[jid] = [];
      saveStore();

      // Delete/clear messages for this document in Firestore
      if (firestoreDb && activeStorePhone) {
        const safeDocId = jid.replace(/\//g, "_");
        const msgDocRef = firestoreDb.collection("accounts").doc(activeStorePhone).collection("messages").doc(safeDocId);
        await msgDocRef.delete().catch((e: any) => console.error("Firestore delete msg error:", e));
      }

      // Broadcast update to all client sockets in real-time
      broadcastToAll("whatsapp:clear-chat", { jid });
      socket.emit("action:success", { type: "clear-chat", jid });
    } catch (err: any) {
      console.error("Clear chat error:", err);
      socket.emit("action:error", { type: "clear-chat", error: err.message });
    }
  });

  // ১৩. চ্যাট ডিলিট (Delete Chat) করা
  socket.on("action:delete-chat", async ({ jid }: { jid: string }) => {
    try {
      if (sock) {
        await sock.chatModify({ delete: true }, jid).catch((e: any) => console.warn("Baileys delete error:", e));
      }
      delete store.chats[jid];
      delete store.messages[jid];
      delete store.contacts[jid];
      saveStore();

      // Delete from Firestore
      if (firestoreDb && activeStorePhone) {
        const safeDocId = jid.replace(/\//g, "_");
        const accountRef = firestoreDb.collection("accounts").doc(activeStorePhone);
        await accountRef.collection("chats").doc(safeDocId).delete().catch((e: any) => console.error(e));
        await accountRef.collection("messages").doc(safeDocId).delete().catch((e: any) => console.error(e));
        await accountRef.collection("contacts").doc(safeDocId).delete().catch((e: any) => console.error(e));
      }

      // Broadcast update to all client sockets in real-time
      broadcastToAll("whatsapp:delete-chat", { jid });
      socket.emit("action:success", { type: "delete-chat", jid });
    } catch (err: any) {
      console.error("Delete chat error:", err);
      socket.emit("action:error", { type: "delete-chat", error: err.message });
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    activeSockets.delete(socket);
  });
});

// CORS Middleware for external access (e.g. GitHub Pages)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }
  next();
});

// Body parser with 50mb limit for base64 file transfers
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const upload = multer({ storage: multer.memoryStorage() });

// send-voice and api/chat/send-voice endpoint to send voice notes
const sendVoiceHandler = async (req: express.Request, res: express.Response): Promise<any> => {
  try {
    const { to } = req.body;
    const audioBuffer = req.file?.buffer;

    if (!audioBuffer || !to) {
      console.warn("[Voice API] Missing file or target number:", { to, fileExists: !!audioBuffer });
      return res.status(400).send("Missing file or target number");
    }

    if (!sock) {
      console.error("[Voice API] WhatsApp client not connected.");
      return res.status(503).send("WhatsApp client is not connected.");
    }

    // format JID
    let jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;

    console.log(`[Voice API] Sending voice note to ${jid}...`);

    // Baileys sends voice note
    const result = await sock.sendMessage(jid, {
      audio: audioBuffer,
      mimetype: req.file?.mimetype || "audio/ogg; codecs=opus",
      ptt: true,
    });

    if (result) {
      if (!store.messages[jid]) store.messages[jid] = [];
      // Remove any existing duplicate id
      store.messages[jid] = store.messages[jid].filter((m: any) => m.key?.id !== result.key?.id);
      store.messages[jid].push(result);
      saveStore();

      const mapped = mapMessage(result);
      if (mapped) {
        broadcastToAll("whatsapp-message-new", { jid, message: mapped });
      }
    }

    console.log("[Voice API] Voice note sent successfully!", result);
    res.status(200).send("Voice note sent successfully");
  } catch (err: any) {
    console.error("[Voice API] Failed to send voice note:", err);
    res.status(500).send("Internal Server Error: " + err.message);
  }
};

app.post("/send-voice", upload.single("voice"), sendVoiceHandler);
app.post("/api/chat/send-voice", upload.single("voice"), sendVoiceHandler);

// Dynamic lazy media downloader endpoint
const getMediaHandler = async (req: express.Request, res: express.Response): Promise<any> => {
  const restoreBuffers = (obj: any): any => {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) {
      return obj.map(restoreBuffers);
    }
    if (typeof obj === "object") {
      if (obj.type === "Buffer" && Array.isArray(obj.data)) {
        return Buffer.from(obj.data);
      }
      const resObj: any = {};
      for (const key of Object.keys(obj)) {
        resObj[key] = restoreBuffers(obj[key]);
      }
      return resObj;
    }
    return obj;
  };

  try {
    const { chatJid, msgId } = req.query;
    if (!chatJid || !msgId) {
      console.warn("[Media API] Missing parameters:", { chatJid, msgId });
      return res.status(400).send("Missing chatJid or msgId");
    }

    // Find the message from cached store
    const chatMessages = store.messages[chatJid as string] || [];
    const message = chatMessages.find((m) => m.key && m.key.id === msgId);

    if (!message) {
      console.warn(`[Media API] Message not found in cache for JID: ${chatJid}, msgId: ${msgId}`);
      return res.status(404).send("Message not found");
    }

    if (!message.message) {
      return res.status(404).send("Message has no content");
    }

    // Identify the media message sub-property
    const messageType = Object.keys(message.message)[0];
    let mediaMessage = message.message[messageType];
    let type: "audio" | "image" | "video" | "document" = "image";

    if (messageType === "audioMessage") {
      type = "audio";
    } else if (messageType === "videoMessage") {
      type = "video";
    } else if (messageType === "documentMessage") {
      type = "document";
    } else if (messageType === "stickerMessage") {
      type = "image"; // Baileys downloadContentFromMessage uses 'image' for stickers
    } else if (messageType === "documentWithCaptionMessage") {
      mediaMessage = message.message.documentWithCaptionMessage?.message?.documentMessage;
      type = "document";
    } else if (messageType === "viewOnceMessage" || messageType === "viewOnceMessageV2") {
      const innerMsg = message.message[messageType]?.message;
      if (innerMsg) {
        const innerType = Object.keys(innerMsg)[0];
        mediaMessage = innerMsg[innerType];
        if (innerType === "audioMessage") type = "audio";
        else if (innerType === "videoMessage") type = "video";
        else if (innerType === "documentMessage") type = "document";
        else if (innerType === "stickerMessage") type = "image";
        else type = "image";
      }
    }

    if (!mediaMessage) {
      return res.status(404).send("No downloadable media found in message");
    }

    // Restore any Buffer fields (like mediaKey, fileSha256, etc.) that got serialized as objects
    const restoredMediaMessage = restoreBuffers(mediaMessage);

    console.log(`[Media API] Downloading media content. Type: ${type}, JID: ${chatJid}`);

    const stream = await downloadContentFromMessage(restoredMediaMessage, type);
    let buffer = Buffer.from([]);
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk]);
    }

    res.setHeader("Content-Type", restoredMediaMessage.mimetype || "application/octet-stream");
    res.send(buffer);
  } catch (err: any) {
    console.error("[Media API] Media download failed:", err);
    res.status(500).send("Error downloading media: " + err.message);
  }
};

app.get("/get-media", getMediaHandler);
app.get("/api/chat/get-media", getMediaHandler);

// Initialize Google Gen AI lazily
let aiClient: GoogleGenAI | null = null;

function getAiClient() {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn("WARNING: GEMINI_API_KEY is not defined. AI features will run in mock-mode.");
      return null;
    }
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// ==========================================
// API ROUTES
// ==========================================

// Chat endpoint (Meta AI Bot)
app.post("/api/chat/meta", async (req, res) => {
  const { message, history } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  const ai = getAiClient();
  if (!ai) {
    // Return a mock reply if API key is not present
    return setTimeout(() => {
      res.json({
        text: `[MOCK MODE] Hello! I received your message: "${message}". Set up your GEMINI_API_KEY in the Secrets panel to get real replies!`,
      });
    }, 1000);
  }

  try {
    // 1. Check if the message is an image generation request
    const isImageRequest = message.trim().toLowerCase().startsWith("/imagine");
    if (isImageRequest) {
      const prompt = message.slice(8).trim();
      if (!prompt) {
        return res.json({ text: "Please provide a prompt. Usage: `/imagine a cute kitten`" });
      }

      try {
        const imgResponse = await ai.models.generateContent({
          model: "gemini-3.1-flash-lite-image",
          contents: {
            parts: [{ text: prompt }],
          },
          config: {
            imageConfig: {
              aspectRatio: "1:1",
            },
          },
        });

        let base64Image = "";
        for (const part of imgResponse.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData) {
            base64Image = part.inlineData.data;
            break;
          }
        }

        if (base64Image) {
          return res.json({
            text: `Here is the image I generated for: "${prompt}"`,
            image: `data:image/png;base64,${base64Image}`,
          });
        } else {
          throw new Error("No image data returned from Gemini");
        }
      } catch (err: any) {
        console.error("Image generation error, falling back to Unsplash source:", err);
        // Fallback to high quality mock visual content for offline/free tier safety
        const fallbackUrl = `https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=600&auto=format&fit=crop&q=80&sig=${encodeURIComponent(prompt)}`;
        return res.json({
          text: `I generated a beautiful scene based on: "${prompt}" (Fallback activated)`,
          image: fallbackUrl,
        });
      }
    }

    // 2. Standard text conversation
    // Format the history for @google/genai chat API
    // The history parameter is an array of { sender: 'user' | 'meta', text: string, type: 'text' | 'image' }
    const formattedContents = [];
    
    // Add system instruction as part of standard text query or config
    const systemInstruction = 
      "You are Meta AI, the advanced AI virtual assistant integrated directly inside WhatsApp Web. " +
      "You are witty, incredibly helpful, polite, and intelligent. " +
      "You must respond in the same language the user is chatting in (English, Bengali/বাংলা, etc.). " +
      "When replying in Bengali, use warm and highly colloquial Bengali, just like a close tech-savvy friend. " +
      "Keep responses scannable, using bullet points, short paragraphs, and WhatsApp emojis where fitting. " +
      "You can suggest /imagine <prompt> if the user wants to generate pictures.";

    // Push previous history if available
    if (history && Array.isArray(history)) {
      const recentHistory = history.slice(-6); // Only last 6 messages to keep tokens low
      for (const msg of recentHistory) {
        if (msg.type === "text") {
          formattedContents.push({
            role: msg.sender === "me" ? "user" : "model",
            parts: [{ text: msg.text }],
          });
        }
      }
    }

    // Push the current message
    formattedContents.push({
      role: "user",
      parts: [{ text: message }],
    });

    const textResponse = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: formattedContents,
      config: {
        systemInstruction,
      },
    });

    return res.json({
      text: textResponse.text || "I'm not sure how to respond to that.",
    });

  } catch (error: any) {
    console.error("Error in /api/chat/meta:", error);
    return res.status(500).json({
      error: "Failed to communicate with AI model.",
      details: error.message,
    });
  }
});

// Transcribe voice message endpoint
app.post("/api/chat/transcribe", async (req, res) => {
  const { audio, mimeType } = req.body;

  if (!audio) {
    return res.status(400).json({ error: "Audio data is required" });
  }

  const ai = getAiClient();
  if (!ai) {
    return setTimeout(() => {
      res.json({ text: "Hello there! (This is a mock transcription because GEMINI_API_KEY is not defined)" });
    }, 1200);
  }

  try {
    const cleanedBase64 = audio.replace(/^data:audio\/\w+;base64,/, "");
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        {
          inlineData: {
            data: cleanedBase64,
            mimeType: mimeType || "audio/webm",
          },
        },
        {
          text: "Please transcribe this audio message accurately. Return ONLY the text transcribed, with no extra annotations, prefixes, or tags.",
        },
      ],
    });

    res.json({ text: response.text?.trim() || "Could not transcribe audio content." });
  } catch (error: any) {
    console.error("Transcription error:", error);
    res.status(500).json({ error: "Failed to transcribe audio", details: error.message });
  }
});

// Analyze image endpoint (multimodal upload helper)
app.post("/api/chat/analyze", async (req, res) => {
  const { image, mimeType, prompt } = req.body;

  if (!image) {
    return res.status(400).json({ error: "Image data is required" });
  }

  const ai = getAiClient();
  if (!ai) {
    return setTimeout(() => {
      res.json({ text: "I see a very nice image! To get a detailed AI analysis, please supply a valid GEMINI_API_KEY in secrets." });
    }, 1000);
  }

  try {
    const cleanedBase64 = image.replace(/^data:image\/\w+;base64,/, "");
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: [
        {
          inlineData: {
            data: cleanedBase64,
            mimeType: mimeType || "image/png",
          },
        },
        {
          text: prompt || "Analyze this image and describe what it is in detail, call out any text or key elements.",
        },
      ],
    });

    res.json({ text: response.text || "No analysis generated." });
  } catch (error: any) {
    console.error("Analysis error:", error);
    res.status(500).json({ error: "Failed to analyze image", details: error.message });
  }
});

// ==========================================
// CLIENT SERVING & DEVELOPMENT SETUP
// ==========================================

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    // SPA fallback
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`WhatsApp Web Server running at http://localhost:${PORT}`);
  });
}

startServer();
