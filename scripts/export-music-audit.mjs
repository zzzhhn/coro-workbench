import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const destination = path.resolve('evidence/music-roundtrip');
await mkdir(destination, { recursive: true });
const server = await createServer({ server: { middlewareMode: true }, logLevel: 'error' });
try {
  const { createDemoProject } = await server.ssrLoadModule('/src/lib/demo.ts');
  const { arrangeForVoices } = await server.ssrLoadModule('/src/lib/arrange.ts');
  const { toMusicXml } = await server.ssrLoadModule('/src/lib/music.ts');
  const original = createDemoProject();
  const satb = arrangeForVoices(original, {
    preset: 'satb',
    style: 'pop',
    difficulty: 'medium',
    percussion: true,
    transpose: 0,
  });
  for (const [name, project] of Object.entries({ original, satb })) {
    await writeFile(path.join(destination, `${name}.json`), JSON.stringify(project, null, 2));
    await writeFile(path.join(destination, `${name}.musicxml`), toMusicXml(project));
  }
  console.log(`Exported two independent-reader fixtures to ${destination}`);
} finally {
  await server.close();
}
