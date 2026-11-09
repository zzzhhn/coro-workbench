// Synthetic test-only evidence. The normal app never uses these endpoints.
import { createBlankProject } from '../src/lib/demo';
import { encodeWav } from '../src/lib/audio';
const realStorage = window.localStorage;
const rescued = new URLSearchParams(location.search).has('rescued');
const phonemeFixture = new URLSearchParams(location.search).get('phoneme');
const prefix = rescued ? 'coro-test-rescued-review:' : 'coro-test-review:';
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => realStorage.getItem(prefix + key),
    setItem: (key: string, value: string) => realStorage.setItem(prefix + key, value),
    removeItem: (key: string) => realStorage.removeItem(prefix + key),
  },
});
const realDatabase = window.indexedDB;
Object.defineProperty(window, 'indexedDB', {
  configurable: true,
  value: {
    open: (name: string, version?: number) => realDatabase.open(prefix + name, version),
  },
});
const jobId = 'a'.repeat(32);
if (!localStorage.getItem('coro.session.v1')) {
  const project = createBlankProject();
  project.id = 'review-fixture';
  project.title = '校对恢复测试';
  project.tempo = 120;
  project.parts[0].id = 'vocals';
  project.parts[0].name = '主唱';
  project.parts[0].role = 'lead';
  project.parts[0].notes = [
    { id: 'note-a', midi: 60, start: 0, duration: 2, velocity: 0.7, origin: 'transcribed' },
    { id: 'note-b', midi: 64, start: 2, duration: 2, velocity: 0.7, origin: 'transcribed' },
  ];
  project.source = {
    kind: 'audio',
    warnings: [],
    analysis: rescued
      ? { transforms: [], quality: { modelEvidenceUrl: `/api/projects/${jobId}/evidence` } }
      : { transforms: [], rawProjectUrl: `/api/projects/${jobId}/raw` },
  };
  project.originalAudio = {
    url: `/api/audio/${jobId}/original.wav`,
    name: 'synthetic.wav',
    duration: 8,
    tempo: 120,
    offsetSeconds: 0,
  };
  localStorage.setItem(
    'coro.session.v1',
    JSON.stringify({ source: project, active: 'source', savedAt: new Date().toISOString() }),
  );
}
const originalFetch = window.fetch.bind(window);
const audio = new AudioBuffer({ length: 64000, sampleRate: 8000, numberOfChannels: 1 });
const samples = audio.getChannelData(0);
for (let i = 0; i < 16000; i++)
  samples[i] = 0.15 * Math.sin((2 * Math.PI * (i < 8000 ? 261.63 : 329.63) * i) / 8000);
const wave = Uint8Array.from(encodeWav(audio));
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === '/api/health') return Response.json(phonemeFixture
    ? { status: 'ok', localOnly: true, engines: { ffmpeg: { ready: true }, basicPitch: { ready: true },
        demucs: { ready: true }, yourMT3: { ready: true }, quality: { ready: true }, phonemeNotes: { ready: phonemeFixture === 'ready' } } }
    : { status: 'setup_required', localOnly: true, engines: {} });
  if (url.startsWith('/api/projects?')) return Response.json({ projects: [] });
  if (url === `/api/audio/${jobId}/original.wav`)
    return new Response(wave, { headers: { 'Content-Type': 'audio/wav' } });
  if (url.endsWith('/pitch/coverage'))
    return Response.json({
      durationSeconds: 8,
      totalIntervals: 2,
      intervals: [
        { kind: 'pitch_disagreement', startSeconds: 0, endSeconds: 1, supportSeconds: 1, supportFraction: 1 },
        { kind: 'fcpe_missing', startSeconds: 1, endSeconds: 2, supportSeconds: 1, supportFraction: 1 },
      ],
      totalsSeconds: {},
      truncated: false,
      note: '原创合成测试数据，仅验证校对交互。',
      groundTruthAvailable: false,
    });
  if (url.includes('/pitch?'))
    return Response.json({
      jobId,
      startSeconds: 0,
      endSeconds: 8,
      durationSeconds: 8,
      frameStepSeconds: 0.1,
      frames: Array.from({ length: 20 }, (_, index) => ({
        seconds: index / 10,
        fcpeMidi: index < 10 ? 60 : 64,
        crepeMidi: index < 10 ? 61 : 64,
        audible: true,
      })),
      integrity: 'stored_file',
      method: 'synthetic test',
      groundTruthAvailable: false,
      note: '测试数据',
    });
  return originalFetch(input, init);
};
void import('../src/main');
