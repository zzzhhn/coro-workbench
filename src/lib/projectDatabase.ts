// Separate from the media database: no audio blobs are copied during migration.
export function openProjectDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('coro-projects', 1);
    request.onupgradeneeded = () => {
      for (const name of ['library', 'drafts', 'meta']) request.result.createObjectStore(name);
    };
    request.onerror = () => reject(request.error ?? new Error('无法打开本机工程库。'));
    request.onblocked = () => reject(new Error('工程库正在升级，请关闭其他 Coro 标签页后重试。'));
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

export async function databaseRequest<T>(
  store: 'library' | 'drafts' | 'meta',
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openProjectDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let request: IDBRequest<T>;
      try {
        request = action(tx.objectStore(store));
      } catch (error) {
        tx.abort();
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('工程保存中断，请检查浏览器存储空间。'));
    });
  } finally {
    db.close();
  }
}
