import { createBlankProject } from '../src/lib/demo';
import { decodeLocalState } from '../src/lib/localCodec';

const fixture = createBlankProject();
fixture.title = 'Storage Guard Fixture';
fixture.parts[0].notes = [{ id: 'kept-note', midi: 60, start: 0, duration: 1, velocity: .8, lyric: 'keep this edit', origin: 'manual' }];
const memory = new Map<string, string>([['coro.session.v1', JSON.stringify({ source: fixture, active: 'source', savedAt: new Date().toISOString() })]]);
let fail = true;
let rejected = 0;
const status = document.querySelector('#guard-report')!;
const report = () => {
  const library = decodeLocalState(memory.get('coro.library.v1') ?? '[]') as Array<{ source: { title: string } }>;
  status.textContent = JSON.stringify({ archiveFailure: fail, rejectedWrites: rejected, archivedTitles: library.map((item) => item.source.title) }, null, 2);
};
Object.defineProperty(window, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (key === 'coro.library.v1' && fail) { rejected++; report(); throw new DOMException('Simulated quota failure', 'QuotaExceededError'); }
    memory.set(key, value); report();
  },
  removeItem: (key: string) => memory.delete(key),
} });
document.querySelector('#allow-archive')!.addEventListener('click', () => { fail = false; report(); });
report();
void import('../src/main');
