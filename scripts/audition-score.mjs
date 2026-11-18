import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// A published score directory is immutable: it may already have audio, ratings or accepted edits.
export async function publishScore(vite, dir, source, project, evidence) {
  try {
    await access(dir);
    throw Error('试听目录已存在，请为新版本另选目录：' + dir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { toMusicXml } = await vite.ssrLoadModule('/src/lib/music.ts');
  const { createProjectBundle } = await vite.ssrLoadModule('/src/lib/projectBundle.ts');
  const parent = dirname(dir);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.score-'));
  try {
    for (const [file, data] of Object.entries(evidence)) {
      await writeFile(join(staging, file), JSON.stringify(data, null, 2));
    }
    await writeFile(join(staging, 'score.musicxml'), toMusicXml(project));
    const bundle = await createProjectBundle(
      { source, arrangement: project, active: 'arrangement', savedAt: project.updatedAt },
      false,
    );
    await writeFile(join(staging, 'score.coro'), bundle);
    await writeFile(join(staging, 'arrangement.json'), JSON.stringify(project));
    await rename(staging, dir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
