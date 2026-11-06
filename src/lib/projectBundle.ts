import { strFromU8, strToU8, unzip, zip } from 'fflate';
import type { ScoreProject } from './types';
import { getLocalAudio, parseProject, registerLocalAssetUrl, saveLocalAudio } from './storage';
import type { WorkspaceState } from './storage';

const MAX_ARCHIVE = 300 * 1024 * 1024;
const MAX_UNCOMPRESSED = 500 * 1024 * 1024;
const ENTRY = /^assets\/[a-z0-9-]+\.(?:wav|png|jpg|bin)$/;

type BundleManifest = {
  format: 'coro-bundle';
  version: 1;
  workspace: WorkspaceState;
  assets: Array<{ path: string; type: string; bytes: number; sha256?: string }>;
  omissions: string[];
};

export async function assetDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readAsset(url: string): Promise<Blob> {
  if (url.startsWith('local:')) {
    const stored = await getLocalAudio(url.slice(6));
    if (!stored) throw new Error('工程引用的本地音频缓存已丢失，无法打包。请重新导入音频。');
    return stored;
  }
  if (
    !url.startsWith('blob:') &&
    !/^\/api\/(?:audio\/[a-f0-9]{32}\/[a-z0-9-]+\.wav$|omr\/jobs\/[a-f0-9]{32}\/pages\/\d+$|source\/[a-f0-9]{32}$)/.test(
      url,
    )
  )
    throw new Error('工程包含外部资源地址，已拒绝自动下载。');
  const response = await fetch(url);
  if (!response.ok) throw new Error('无法读取工程素材。请保持本地服务运行。');
  return response.blob();
}

export function originalFileUrl(audio: NonNullable<ScoreProject['originalAudio']>): string {
  const jobId = audio.url.match(/^\/api\/audio\/([a-f0-9]{32})\/original\.wav$/)?.[1];
  return audio.fileUrl ?? (jobId ? `/api/source/${jobId}` : audio.url);
}

export async function readOriginalFile(audio: NonNullable<ScoreProject['originalAudio']>): Promise<Blob> {
  return readAsset(originalFileUrl(audio));
}

export function unpackProjectArchive(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  let total = 0;
  let count = 0;
  const names = new Set<string>();
  return new Promise((resolve, reject) => {
    try {
      unzip(
        data,
        {
          filter: (entry) => {
            total += entry.originalSize;
            count++;
            if (total > MAX_UNCOMPRESSED || count > 100 || names.has(entry.name))
              throw new Error('解压工程超出安全限制或包含重复文件。');
            names.add(entry.name);
            if (entry.name !== 'manifest.json' && !ENTRY.test(entry.name))
              throw new Error('工程包含不安全或未知路径。');
            return true;
          },
        },
        (error, files) => (error ? reject(error) : resolve(files)),
      );
    } catch (error) {
      reject(error);
    }
  });
}

export async function createProjectBundle(
  workspace: WorkspaceState,
  includeStems: boolean,
  onProgress: (message: string) => void = () => {},
): Promise<Uint8Array> {
  const copied = structuredClone(workspace);
  const files: Record<string, Uint8Array> = {};
  const seen = new Map<string, string>();
  const manifest: BundleManifest = {
    format: 'coro-bundle',
    version: 1,
    workspace: copied,
    assets: [],
    omissions: [],
  };
  let total = 0;
  const bundleAsset = async (url: string) => {
    if (seen.has(url)) return seen.get(url)!;
    onProgress(`正在打包本地素材 ${seen.size + 1}…`);
    const blob = await readAsset(url);
    total += blob.size;
    if (total > MAX_UNCOMPRESSED)
      throw new Error('工程素材超过 500 MB。请关闭分离音轨打包，或导出较短工程。');
    const extension = blob.type.startsWith('image/') ? 'png' : blob.type === 'audio/wav' ? 'wav' : 'bin';
    const path = `assets/asset-${seen.size + 1}.${extension}`;
    files[path] = new Uint8Array(await blob.arrayBuffer());
    manifest.assets.push({
      path,
      type: blob.type || 'audio/wav',
      bytes: blob.size,
      sha256: await assetDigest(files[path]),
    });
    const reference = `bundle:${path}`;
    seen.set(url, reference);
    return reference;
  };
  for (const project of [copied.source, copied.arrangement].filter((item): item is ScoreProject =>
    Boolean(item),
  )) {
    if (project.originalAudio) {
      // Keep playable decoded audio and the byte-exact upload as separate assets.
      const fileUrl = originalFileUrl(project.originalAudio);
      if (project.originalAudio.fileUrl || fileUrl !== project.originalAudio.url)
        project.originalAudio.fileUrl = await bundleAsset(fileUrl);
      project.originalAudio.url = await bundleAsset(project.originalAudio.url);
    }
    for (const part of project.parts) {
      if (!part.stemUrl) continue;
      if (includeStems) part.stemUrl = await bundleAsset(part.stemUrl);
      else {
        delete part.stemUrl;
        manifest.omissions.push(`未包含分轨：${part.name}`);
      }
    }
    if (project.source.pages) {
      for (let index = 0; index < project.source.pages.length; index++)
        project.source.pages[index] = await bundleAsset(project.source.pages[index]);
    }
    if (project.source.analysis?.rawProjectUrl) {
      project.source.analysis.rawProjectUrl = undefined;
      manifest.omissions.push('原始模型提案可在原工作台另存；此包保留当前原曲及编配。');
    }
    if (project.source.analysis?.quality) {
      for (const key of ['leadAudioUrl', 'backingAudioUrl', 'modelEvidenceUrl']) {
        const url = project.source.analysis.quality[key];
        if (typeof url !== 'string') continue;
        if (includeStems && key !== 'modelEvidenceUrl')
          project.source.analysis.quality[key] = await bundleAsset(url);
        else delete project.source.analysis.quality[key];
      }
    }
  }
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  onProgress('正在压缩便携工程…');
  const archive = await new Promise<Uint8Array>((resolve, reject) =>
    zip(files, { level: 1 }, (error, data) => (error ? reject(error) : resolve(data))),
  );
  if (archive.byteLength > MAX_ARCHIVE) throw new Error('压缩工程超过 300 MB，请不要打包分离音轨。');
  return archive;
}

export async function importProjectBundle(file: File): Promise<WorkspaceState> {
  if (file.size > MAX_ARCHIVE) throw new Error('便携工程文件不能超过 300 MB。');
  const entries = await unpackProjectArchive(new Uint8Array(await file.arrayBuffer()));
  if (!entries['manifest.json'] || entries['manifest.json'].byteLength > 30_000_000)
    throw new Error('没有找到有效的 Coro 工程清单。');
  const manifest = JSON.parse(strFromU8(entries['manifest.json'])) as BundleManifest;
  if (
    !manifest ||
    manifest.format !== 'coro-bundle' ||
    manifest.version !== 1 ||
    !manifest.workspace?.source ||
    !Array.isArray(manifest.assets)
  )
    throw new Error('不支持此工程包格式。');
  const workspace = manifest.workspace;
  const assetKeys = new Map<string, string>();
  const staged: Array<{ key: string; blob: Blob }> = [];
  const references = new Map<string, string>();
  for (const asset of manifest.assets) {
    if (
      !ENTRY.test(asset.path) ||
      !entries[asset.path] ||
      entries[asset.path].length !== asset.bytes ||
      !/^(?:audio\/|image\/|application\/octet-stream$)/.test(asset.type) ||
      assetKeys.has(asset.path)
    )
      throw new Error('工程素材清单与内容不一致。');
    if (
      asset.sha256 !== undefined &&
      (!/^[a-f0-9]{64}$/.test(asset.sha256) || (await assetDigest(entries[asset.path])) !== asset.sha256)
    )
      throw new Error('工程素材校验失败。文件内容已损坏或被修改，未导入任何素材。');
    const key = `bundle-${crypto.randomUUID()}`;
    assetKeys.set(asset.path, key);
    staged.push({ key, blob: new Blob([Uint8Array.from(entries[asset.path])], { type: asset.type }) });
    references.set(`bundle:${asset.path}`, `local:${key}`);
  }
  const checked = (project: ScoreProject): ScoreProject => {
    const next = structuredClone(project);
    if (next.originalAudio) {
      const url = references.get(next.originalAudio.url);
      if (!url) throw new Error('工程缺少原音频素材。');
      next.originalAudio.url = url;
      if (next.originalAudio.fileUrl) {
        const fileUrl = references.get(next.originalAudio.fileUrl);
        if (!fileUrl) throw new Error('工程缺少未经转码的原文件。');
        next.originalAudio.fileUrl = fileUrl;
      }
    }
    const stems = new Map<string, string>();
    for (const part of next.parts)
      if (part.stemUrl) {
        const url = references.get(part.stemUrl);
        if (!url) throw new Error('工程缺少分离音轨。');
        stems.set(part.id, url);
        delete part.stemUrl;
      }
    const pages = next.source.pages?.map((url) => {
      const mapped = references.get(url);
      if (!mapped) throw new Error('工程缺少原始谱页。');
      return mapped;
    });
    delete next.source.pages;
    if (next.source.analysis?.quality)
      for (const key of ['leadAudioUrl', 'backingAudioUrl']) {
        const value = next.source.analysis.quality[key];
        if (typeof value === 'string') {
          const mapped = references.get(value);
          if (!mapped) throw new Error('工程缺少主唱/伴唱分支素材。');
          next.source.analysis.quality[key] = mapped;
        }
      }
    const validated = parseProject(JSON.stringify(next));
    for (const part of validated.parts) if (stems.has(part.id)) part.stemUrl = stems.get(part.id);
    if (pages) validated.source.pages = pages;
    return validated;
  };
  const result: WorkspaceState = {
    source: checked(workspace.source),
    arrangement: workspace.arrangement ? checked(workspace.arrangement) : undefined,
    active: workspace.active === 'arrangement' && workspace.arrangement ? 'arrangement' : 'source',
    savedAt: new Date().toISOString(),
  };
  // Validate all symbolic data and references before mutating the browser asset store.
  for (const { key, blob } of staged) await saveLocalAudio(key, blob);
  return result;
}

export async function resolveLocalAsset(url: string): Promise<string> {
  if (!url.startsWith('local:')) return url;
  const blob = await getLocalAudio(url.slice(6));
  if (!blob) throw new Error('本地工程素材丢失，请重新导入便携工程。');
  const resolved = URL.createObjectURL(blob);
  registerLocalAssetUrl(resolved, url.slice(6));
  return resolved;
}
