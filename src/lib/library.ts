import { decodeLocalState } from './localCodec';
import { safeProject, type WorkspaceState } from './storage';
import { validateProject } from './music';
import { databaseRequest, openProjectDatabase } from './projectDatabase';

export interface LibraryEntry {
  id: string;
  kind: 'project' | 'version';
  name?: string;
  workspace: WorkspaceState;
  exportReceipt?: { createdAt: string; fingerprint: string };
}
const LEGACY_KEY = 'coro.library.v1';

export function safeWorkspace(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    source: safeProject(state.source),
    arrangement: state.arrangement ? safeProject(state.arrangement) : undefined,
  };
}

export async function workspaceFingerprint(state: WorkspaceState): Promise<string> {
  const safe = safeWorkspace(state);
  const bytes = new TextEncoder().encode(JSON.stringify([safe.source, safe.arrangement]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export async function migrateLibrary(): Promise<void> {
  const db = await openProjectDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['library', 'meta'], 'readwrite');
      const meta = tx.objectStore('meta'),
        library = tx.objectStore('library');
      let cause: unknown;
      meta.get('legacy-library-migrated').onsuccess = (event) => {
        if ((event.target as IDBRequest).result) return;
        try {
          const raw = decodeLocalState(localStorage.getItem(LEGACY_KEY) ?? '[]');
          if (!Array.isArray(raw)) throw new Error('旧工程库格式无法读取，原记录已保留。');
          for (const state of raw as WorkspaceState[]) {
            if (
              !state?.source ||
              validateProject(state.source).length ||
              (state.arrangement && validateProject(state.arrangement).length)
            )
              throw new Error('旧工程库包含无法读取的工程，原记录已保留。');
            const id = `project:${state.source.id}`;
            const existing = library.get(id);
            existing.onsuccess = () => {
              try {
                if (!existing.result)
                  library.put(
                    { id, kind: 'project', workspace: safeWorkspace(state) } satisfies LibraryEntry,
                    id,
                  );
              } catch (error) {
                cause = error;
                tx.abort();
              }
            };
          }
          meta.put(true, 'legacy-library-migrated');
        } catch (error) {
          cause = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(cause ?? tx.error ?? new Error('旧工程库迁移失败，原记录已保留。'));
    });
    // Only remove the legacy copy after the complete transaction succeeds.
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* A duplicate is safe. */
    }
  } finally {
    db.close();
  }
}

export async function archiveWorkspace(state: WorkspaceState, name?: string): Promise<LibraryEntry> {
  await migrateLibrary();
  const id = name === undefined ? `project:${state.source.id}` : `version:${crypto.randomUUID()}`;
  const entry: LibraryEntry = {
    id,
    kind: name === undefined ? 'project' : 'version',
    name,
    workspace: safeWorkspace(state),
  };
  const db = await openProjectDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('library', 'readwrite'),
        store = tx.objectStore('library');
      let cause: unknown;
      const previous = store.get(id);
      previous.onsuccess = () => {
        try {
          entry.exportReceipt = previous.result?.exportReceipt;
          store.put(entry, id);
        } catch (error) {
          cause = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(cause ?? tx.error ?? new Error('工程未保存，请重试。'));
    });
    return entry;
  } finally {
    db.close();
  }
}

export async function readLibrary(): Promise<LibraryEntry[]> {
  await migrateLibrary();
  const entries = await databaseRequest<LibraryEntry[]>('library', 'readonly', (store) => store.getAll());
  return entries.sort((a, b) => b.workspace.savedAt.localeCompare(a.workspace.savedAt));
}

export async function deleteLibraryEntry(id: string): Promise<void> {
  await databaseRequest('library', 'readwrite', (store) => store.delete(id));
}

export async function recordBundleExport(state: WorkspaceState): Promise<void> {
  const fingerprint = await workspaceFingerprint(state);
  await archiveWorkspace(state);
  const db = await openProjectDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('library', 'readwrite'),
        store = tx.objectStore('library');
      const id = `project:${state.source.id}`,
        request = store.get(id);
      request.onsuccess = () => {
        if (request.result)
          store.put(
            { ...request.result, exportReceipt: { createdAt: new Date().toISOString(), fingerprint } },
            id,
          );
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
