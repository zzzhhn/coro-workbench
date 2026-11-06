import abcjs from 'abcjs';
import { zip } from 'fflate';
import { beatsPerBar, toAbc } from './music';
import { fitEngravingSystems, prepareEngravingTune } from './engraving';
import { renderProjectAudio } from './audio';
import { jsonResponse } from './api';
import type { ScoreProject } from './types';

export interface VideoJob {
  id: string;
  status: 'queued' | 'running' | 'complete' | 'error' | 'cancelled';
  progress: number;
  stage: string;
  message: string;
  error?: string;
  downloadUrl?: string;
}
const WIDTH = 1920;
const HEIGHT = 1080;

async function png(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Uint8Array(
    await (
      await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('浏览器无法生成谱面图像。'))),
          'image/png',
        ),
      )
    ).arrayBuffer(),
  );
}

async function svgImage(svg: SVGSVGElement): Promise<HTMLImageElement> {
  const serialized = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function createVideoPackage(
  project: ScoreProject,
  partIds: string[] | undefined,
  onProgress: (message: string) => void,
): Promise<Uint8Array> {
  const duration = (project.measures * beatsPerBar(project) * 60) / project.tempo;
  if (duration > 1200) throw new Error('MP4 每次最多导出 20 分钟，请先裁剪范围。');
  onProgress('正在离线渲染排练音轨…');
  const { bytes, buffer } = await renderProjectAudio(project, partIds);
  const holder = document.createElement('div');
  holder.style.cssText =
    'position:fixed;left:-20000px;top:0;width:1780px;background:white;pointer-events:none';
  holder.setAttribute('aria-hidden', 'true');
  document.body.append(holder);
  const files: Record<string, Uint8Array> = { 'audio.wav': bytes };
  const frames: Array<{ file: string; duration: number }> = [];
  try {
    const score = {
      ...project,
      title: '',
      composer: '',
      parts: project.parts
        .filter((part) => !partIds || partIds.includes(part.id))
        .map((part) => ({ ...part, name: part.name.split(' · ')[0] })),
    };
    const notation = toAbc(score, undefined, { barsPerSystem: 2, staffSep: 30, systemSep: 26 });
    abcjs.renderAbc(holder, notation.abc, {
      oneSvgPerLine: true,
      staffwidth: 1650,
      paddingtop: 0,
      paddingbottom: 20,
      paddingleft: 12,
      paddingright: 20,
      afterParsing: (tune) => prepareEngravingTune(tune, notation),
      format: {
        voicefont: 'sans-serif 12',
        vocalfont: 'sans-serif 14',
        gchordfont: 'sans-serif 15',
        measurefont: 'sans-serif 11',
      },
    });
    await document.fonts.ready;
    const systems = [...holder.querySelectorAll<SVGSVGElement>('svg')];
    const boxes = fitEngravingSystems(systems);
    if (!systems.length || systems.length > 512) throw new Error('谱面系统过多或没有可导出的谱面。');
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器未提供视频绘制能力。');
    for (const [index, svg] of systems.entries()) {
      onProgress(`生成谱面视频帧 ${index + 1}/${systems.length}…`);
      const box = boxes[index];
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      svg.setAttribute('width', String(box.width));
      svg.setAttribute('height', String(box.height));
      svg.style.removeProperty('width');
      svg.style.removeProperty('height');
      const measure = notation.systemMeasures?.[index] ?? index * 2 + 1;
      const next = notation.systemMeasures?.[index + 1] ?? Math.min(project.measures + 1, measure + 2);
      const end = Math.min(project.measures, next - 1);
      const image = await svgImage(svg);
      context.fillStyle = '#f0f2f4';
      context.fillRect(0, 0, WIDTH, HEIGHT);
      context.fillStyle = '#ffffff';
      context.fillRect(38, 38, WIDTH - 76, HEIGHT - 76);
      context.fillStyle = '#2c333e';
      context.font = '500 32px "DM Sans", "PingFang SC", sans-serif';
      let title = project.title;
      while (context.measureText(title).width > WIDTH - 530 && title.length > 4) title = title.slice(0, -2);
      context.fillText(title, 76, 93);
      context.font = '18px "DM Sans", "PingFang SC", sans-serif';
      context.fillStyle = '#68717e';
      context.fillText(`${project.key}   ${project.timeSignature.join('/')}   ${project.tempo} BPM`, 76, 128);
      context.textAlign = 'right';
      context.fillText(`小节 ${measure}–${end} / ${project.measures}`, WIDTH - 76, 93);
      context.textAlign = 'left';
      const scale = Math.min((WIDTH - 145) / box.width, (HEIGHT - 258) / box.height);
      const drawWidth = box.width * scale,
        drawHeight = box.height * scale;
      context.drawImage(
        image,
        (WIDTH - drawWidth) / 2,
        163 + Math.max(0, (HEIGHT - 258 - drawHeight) / 2),
        drawWidth,
        drawHeight,
      );
      context.fillStyle = '#939ba6';
      context.font = '16px "DM Sans", "PingFang SC", sans-serif';
      context.fillText('Coro 本地排练谱 · 合成音色仅作音高与节奏参考', 76, HEIGHT - 65);
      context.fillStyle = '#d9dee4';
      context.fillRect(76, HEIGHT - 48, WIDTH - 152, 3);
      context.fillStyle = '#ad6348';
      context.fillRect(76, HEIGHT - 48, ((WIDTH - 152) * (index + 1)) / systems.length, 3);
      const filename = `frame-${String(index).padStart(4, '0')}.png`;
      files[filename] = await png(canvas);
      frames.push({
        file: filename,
        duration: ((next - measure) * beatsPerBar(project) * 60) / project.tempo,
      });
    }
    const visualDuration = frames.reduce((sum, frame) => sum + frame.duration, 0);
    frames.at(-1)!.duration += buffer.duration - visualDuration;
    files['manifest.json'] = new TextEncoder().encode(
      JSON.stringify({ version: 1, title: project.title, frames, duration: buffer.duration }),
    );
    onProgress('正在打包本地视频帧…');
    const payload = await new Promise<Uint8Array>((resolve, reject) =>
      zip(files, { level: 0 }, (error, result) => (error ? reject(error) : resolve(result))),
    );
    if (payload.byteLength > 300 * 1024 * 1024)
      throw new Error('视频渲染包超过 300 MB，请缩短乐谱或只导出需要的声部。');
    return payload;
  } finally {
    holder.remove();
  }
}

export async function startVideoExport(archive: Uint8Array): Promise<VideoJob> {
  const data = new FormData();
  data.append('file', new Blob([Uint8Array.from(archive)], { type: 'application/zip' }), 'render.zip');
  return jsonResponse(await fetch('/api/video', { method: 'POST', body: data }));
}
export const getVideoJob = async (id: string): Promise<VideoJob> =>
  jsonResponse(await fetch(`/api/video/jobs/${encodeURIComponent(id)}`));
export const cancelVideoJob = async (id: string): Promise<VideoJob> =>
  jsonResponse(await fetch(`/api/video/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }));
