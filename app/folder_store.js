// Remembers the last folder picked, so a return visit is one click
// ("Reopen …") rather than a trip through the folder picker. A
// FileSystemDirectoryHandle can be stored in IndexedDB as-is; Chrome asks
// for permission again the first time it's used in a new session.
//
// Every call is best-effort: private windows, blocked storage and the like
// just mean nothing is remembered.

const DB_NAME = "chordpro-songbook";
const STORE = "handles";
const KEY = "last-folder";

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadLastFolder() {
  try { return (await withStore("readonly", (store) => store.get(KEY))) || null; }
  catch { return null; }
}

export async function saveLastFolder(handle) {
  try { await withStore("readwrite", (store) => store.put(handle, KEY)); }
  catch { /* nothing remembered — fine */ }
}
