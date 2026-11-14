import { unzipSync, strFromU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import { fromMidi, fromMusicXml, validateOmrReview } from './music';
import { parseProject } from './storage';
import type { ScoreProject, OmrJob } from './types';

const MAX_SCORE_BYTES = 30 * 1024 * 1024;

export function projectFromOmr(job: OmrJob): ScoreProject {
  if (job.status !== 'complete' || !job.musicxml) throw new Error('光学识谱还没有返回可读取的乐谱。');
  const project = fromMusicXml(job.musicxml);
  project.title = job.source?.filename.replace(/\.[^.]+$/, '') ?? project.title;
  const counts = new Map<string, number>();
  for (const part of project.parts) counts.set(part.name, (counts.get(part.name) ?? 0) + 1);
  for (const [index, part] of project.parts.entries()) {
    if ((counts.get(part.name) ?? 0) > 1 || /^voice$/i.test(part.name)) {
      part.name = `识谱声部 ${index + 1}`;
      part.shortName = `P${index + 1}`;
    }
    for (const note of part.notes) note.origin = 'transcribed';
  }
  project.source = {
    ...project.source,
    kind: 'omr',
    filename: job.source?.filename,
    engine: job.source?.engine,
    warnings: [...new Set([...(job.warnings ?? []), ...project.source.warnings])],
    pages: job.pageUrls?.filter((url) => /^\/api\/omr\/jobs\/[a-f0-9]{32}\/pages\/\d+$/.test(url)),
  };
  if (job.review) {
    const problems = validateOmrReview(job.review);
    const pageCount = project.source.pages?.length ?? 0;
    if (!problems.length && job.review.pages.every((page) => page.page < pageCount))
      project.source.omrReview = structuredClone(job.review);
    else project.source.warnings.push('识谱原图对照数据无效，已忽略；音符与原谱页不受影响。');
  }
  return project;
}

export async function importScoreFile(file: File): Promise<ScoreProject> {
  if (file.size > MAX_SCORE_BYTES) throw new Error('乐谱文件需小于 30 MB。');
  const name = file.name.toLowerCase();
  let project: ScoreProject;
  if (/\.(mid|midi)$/.test(name)) project = fromMidi(await file.arrayBuffer());
  else if (/\.json$/.test(name)) return parseProject(await file.text());
  else if (/\.mxl$/.test(name)) {
    let total = 0;
    const archive = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (entry) => {
        total += entry.originalSize;
        if (total > MAX_SCORE_BYTES) throw new Error('解压后的乐谱超过 30 MB 上限。');
        return (
          /\.(xml|musicxml)$/i.test(entry.name) && !entry.name.startsWith('/') && !entry.name.includes('..')
        );
      },
    });
    const container = archive['META-INF/container.xml'];
    let path: string | undefined;
    if (container) {
      const parsed = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(
        strFromU8(container),
      );
      const root = parsed?.container?.rootfiles?.rootfile;
      path = (Array.isArray(root) ? root[0] : root)?.['@_full-path'];
    }
    path ??= Object.keys(archive).find((key) => !key.startsWith('META-INF/'));
    if (!path || !archive[path]) throw new Error('MXL 压缩包中没有找到有效的 MusicXML 乐谱。');
    project = fromMusicXml(strFromU8(archive[path]));
  } else project = fromMusicXml(await file.text());
  project.source.filename = file.name;
  return project;
}
