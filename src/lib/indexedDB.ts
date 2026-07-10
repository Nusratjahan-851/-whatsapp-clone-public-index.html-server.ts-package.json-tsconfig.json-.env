// IndexedDB wrapper to store unlimited WhatsApp messages, contacts, and media safely.
// Since localStorage is limited to 5MB, IndexedDB allows storing up to hundreds of MBs of data for free.

const DB_NAME = "WhatsAppWebCloneDB";
const DB_VERSION = 1;

export interface DBData {
  chats: Record<string, any[]>;
  contacts: any[];
  userProfile: any;
  theme: string;
}

export function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (event) => {
      console.error("IndexedDB error:", event);
      reject(new Error("Failed to open IndexedDB"));
    };

    request.onsuccess = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      // Store chats mapped by contact ID
      if (!db.objectStoreNames.contains("chats")) {
        db.createObjectStore("chats");
      }
      // Store general key-value settings (profile, theme, contacts list)
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings");
      }
    };
  });
}

// Save all chats for a specific contact
export async function saveChatHistory(contactId: string, messages: any[]): Promise<void> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["chats"], "readwrite");
      const store = transaction.objectStore("chats");
      const request = store.put(messages, contactId);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error("Failed to save chat to IndexedDB:", err);
  }
}

// Retrieve chat history for all contacts
export async function loadAllChats(): Promise<Record<string, any[]>> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["chats"], "readonly");
      const store = transaction.objectStore("chats");
      const request = store.getAll();
      const keysRequest = store.getAllKeys();

      let messages: any[][] = [];
      let keys: any[] = [];

      request.onsuccess = () => {
        messages = request.result;
        if (keys.length > 0 || keysRequest.readyState === "done") {
          const chatsRecord: Record<string, any[]> = {};
          keys.forEach((key, idx) => {
            chatsRecord[key] = messages[idx];
          });
          resolve(chatsRecord);
        }
      };

      keysRequest.onsuccess = () => {
        keys = keysRequest.result;
        if (messages.length > 0 || request.readyState === "done") {
          const chatsRecord: Record<string, any[]> = {};
          keys.forEach((key, idx) => {
            chatsRecord[key] = messages[idx];
          });
          resolve(chatsRecord);
        }
      };

      request.onerror = () => reject(request.error);
      keysRequest.onerror = () => reject(keysRequest.error);
    });
  } catch (err) {
    console.error("Failed to load chats from IndexedDB:", err);
    return {};
  }
}

// Generic key-value store helpers for contacts list, user profile, theme
export async function saveSetting(key: string, value: any): Promise<void> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["settings"], "readwrite");
      const store = transaction.objectStore("settings");
      const request = store.put(value, key);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error(`Failed to save setting ${key} to IndexedDB:`, err);
  }
}

export async function loadSetting<T>(key: string, defaultValue: T): Promise<T> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["settings"], "readonly");
      const store = transaction.objectStore("settings");
      const request = store.get(key);

      request.onsuccess = () => {
        if (request.result !== undefined) {
          resolve(request.result as T);
        } else {
          resolve(defaultValue);
        }
      };
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error(`Failed to load setting ${key} from IndexedDB:`, err);
    return defaultValue;
  }
}

// Clear all data stores on logout
export async function clearAllData(): Promise<void> {
  try {
    const db = await initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(["chats", "settings"], "readwrite");
      const chatsStore = transaction.objectStore("chats");
      const settingsStore = transaction.objectStore("settings");
      
      chatsStore.clear();
      settingsStore.clear();
      
      transaction.oncomplete = () => {
        console.log("IndexedDB cleared successfully.");
        resolve();
      };
      
      transaction.onerror = () => {
        console.error("Failed to clear IndexedDB:", transaction.error);
        reject(transaction.error);
      };
    });
  } catch (err) {
    console.error("Failed to clear IndexedDB database:", err);
  }
}
