// 本机照片库：把导入的照片存在浏览器 IndexedDB 里，刷新 / 下次打开自动加载
export type PhotoItem = {
  id?: number;
  name: string;
  type: string;
  blob: Blob;
  width: number;
  height: number;
  addedAt: number;
};

const DB_NAME = 'photo-christmas-tree';
const STORE = 'photos';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexeddb-unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        os.createIndex('addedAt', 'addedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('db-open-failed'));
    req.onblocked = () => reject(new Error('db-blocked'));
  });
  return dbPromise;
};

const txDone = (tx: IDBTransaction): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('tx-error'));
    tx.onabort = () => reject(tx.error ?? new Error('tx-aborted'));
  });

export const listPhotos = async (): Promise<PhotoItem[]> => {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).getAll();
  const rows = await new Promise<PhotoItem[]>((resolve, reject) => {
    req.onsuccess = () => resolve((req.result || []) as PhotoItem[]);
    req.onerror = () => reject(req.error ?? new Error('get-all-failed'));
  });
  return rows.sort((a, b) => a.addedAt - b.addedAt);
};

const removePhotos = async (ids: number[]): Promise<void> => {
  if (!ids.length) return;
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const os = tx.objectStore(STORE);
  ids.forEach((id) => os.delete(id));
  await txDone(tx);
};

export const addPhotos = async (
  items: Omit<PhotoItem, 'id' | 'addedAt'>[],
  maxKeep: number
): Promise<PhotoItem[]> => {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  const os = tx.objectStore(STORE);
  const base = Date.now();
  items.forEach((it, i) => os.add({ ...it, addedAt: base + i }));
  await txDone(tx);
  let all = await listPhotos();
  if (maxKeep > 0 && all.length > maxKeep) {
    const extra = all.slice(0, all.length - maxKeep);
    await removePhotos(extra.map((p) => p.id as number).filter((v) => typeof v === 'number'));
    all = await listPhotos();
  }
  return all;
};

export const clearPhotos = async (): Promise<void> => {
  const db = await openDb();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await txDone(tx);
};

// 请求浏览器不要轻易回收本站数据（部分浏览器支持，失败时静默忽略）
export const requestPersistence = async (): Promise<boolean> => {
  try {
    const storage = navigator.storage as any;
    if (storage && typeof storage.persist === 'function') {
      return await storage.persist();
    }
  } catch {
    // ignore
  }
  return false;
};
