import { createBlankProject } from '../src/lib/demo';

const fixture = createBlankProject();
fixture.title = 'Storage Guard Fixture';
fixture.parts[0].notes = [{ id: 'kept-note', midi: 60, start: 0, duration: 1, velocity: .8, lyric: 'keep this edit', origin: 'manual' }];
const memory = new Map<string, string>([['coro.session.v1', JSON.stringify({ source: fixture, active: 'source', savedAt: new Date().toISOString() })]]);
let fail = true;
let rejected = 0;
const status = document.querySelector('#guard-report')!;
const report = () => {
  status.textContent = JSON.stringify({ archiveFailure: fail, rejectedWrites: rejected });
};
Object.defineProperty(window, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value); report();
  },
  removeItem: (key: string) => memory.delete(key),
} });
const realDatabase = window.indexedDB, suffix = crypto.randomUUID();
const databases = new Set<string>();
Object.defineProperty(window, 'indexedDB', { configurable: true, value: {
  open: (name: string, version?: number) => {
    if (fail && name === 'coro-projects') { rejected++; report(); throw new DOMException('Simulated write failure', 'QuotaExceededError'); }
    const isolated = `${name}-guard-${suffix}`;
    databases.add(isolated);
    return realDatabase.open(isolated, version);
  },
} });
window.addEventListener('pagehide', () => { for (const name of databases) realDatabase.deleteDatabase(name); });
document.querySelector('#allow-archive')!.addEventListener('click', () => { fail = false; report(); });
report();
void import('../src/main');
