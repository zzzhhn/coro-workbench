import abcjs from 'abcjs';
import type { ScoreProject } from './types';
import { toAbc } from './music';
import { alignEngravingArpeggios, alignEngravingStaffNames, fitEngravingSystems, prepareEngravingTune } from './engraving';

let fontPromise: Promise<string> | undefined;
async function localFont(): Promise<string> {
  if (!fontPromise)
    fontPromise = fetch('/fonts/NotoSansSC-Regular.ttf')
      .then(async (response) => {
        if (!response.ok) throw new Error('本地 PDF 中文字体未找到。请检查安装。');
        const bytes = new Uint8Array(await response.arrayBuffer());
        const browserFont = await new FontFace('CoroCJK', bytes).load();
        document.fonts.add(browserFont);
        const chunks: string[] = [];
        for (let offset = 0; offset < bytes.length; offset += 16384)
          chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 16384)));
        return btoa(chunks.join(''));
      })
      .catch((error) => {
        fontPromise = undefined;
        throw error;
      });
  return fontPromise;
}

export async function renderScorePdf(project: ScoreProject, partIds?: string[]): Promise<Uint8Array> {
  const [{ jsPDF }, { svg2pdf }, font] = await Promise.all([
    import('jspdf'),
    import('svg2pdf.js'),
    localFont(),
  ]);
  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
    putOnlyUsedFonts: true,
  });
  pdf.addFileToVFS('CoroCJK.ttf', font);
  for (const style of ['normal', 'bold', 'italic', 'bolditalic'])
    pdf.addFont('CoroCJK.ttf', 'CoroCJK', style);
  pdf.setFont('CoroCJK', 'normal');
  pdf.setProperties({
    title: project.title,
    author: project.composer,
    subject: project.arrangement ? 'A cappella rehearsal score' : 'Full score',
    creator: 'Coro local workbench',
  });
  const holder = document.createElement('div');
  holder.style.cssText =
    'position:fixed;left:-12000px;top:0;width:950px;background:white;pointer-events:none;';
  holder.setAttribute('aria-hidden', 'true');
  document.body.appendChild(holder);
  const parts = project.parts.filter((part) => !partIds || partIds.includes(part.id));
  const notationResult = toAbc(
    {
      ...project,
      title: '',
      composer: '',
      parts: parts.map((part) => ({ ...part, name: part.name.split(' · ')[0] })),
    },
    undefined,
    { barsPerSystem: 4, staffSep: 42, systemSep: 37 },
  );
  try {
    abcjs.renderAbc(holder, notationResult.abc, {
      afterParsing: (tune) => prepareEngravingTune(tune, notationResult),
      add_classes: true,
      oneSvgPerLine: true,
      staffwidth: 875,
      paddingtop: 0,
      paddingbottom: 15,
      paddingleft: 8,
      paddingright: 8,
      format: {
        voicefont: 'CoroCJK 11',
        vocalfont: 'CoroCJK 12',
        gchordfont: 'CoroCJK 12',
        composerfont: 'CoroCJK 11',
        titlefont: 'CoroCJK 18',
        measurefont: 'CoroCJK 9',
      },
    });
    const width = 186;
    let y = 19;
    pdf.setFontSize(19);
    const titleLines = pdf.splitTextToSize(project.title, width) as string[];
    pdf.setTextColor('#29313a');
    pdf.text(titleLines, 105, y, { align: 'center' });
    y += titleLines.length * 8 + 2;
    pdf.setFontSize(8);
    pdf.setTextColor('#68717e');
    pdf.text(project.composer, 105, y, { align: 'center' });
    y += 8;
    pdf.text(
      `${project.key}   ${project.timeSignature.join('/')}   BPM ${project.tempo}   ${project.measures} bars   ${parts.length} parts`,
      12,
      y,
    );
    y += 6;
    const systems = [...holder.querySelectorAll<SVGSVGElement>('svg')];
    if (!systems.length) throw new Error('没有可导出的谱面。');
    alignEngravingStaffNames(systems);
    alignEngravingArpeggios(systems);
    const boxes = fitEngravingSystems(systems);
    for (const [index, system] of systems.entries()) {
      const { width: originalWidth, height: originalHeight } = boxes[index];
      let height = (originalHeight / originalWidth) * width;
      let renderWidth = width;
      if (height > 250) {
        renderWidth = (width * 250) / height;
        height = 250;
      }
      if (y + height > 278) {
        pdf.addPage();
        y = 15;
      }
      system.setAttribute('width', String(originalWidth));
      system.setAttribute('height', String(originalHeight));
      system.style.removeProperty('width');
      system.style.removeProperty('height');
      for (const text of system.querySelectorAll('text, tspan')) {
        text.setAttribute('font-family', 'CoroCJK');
        (text as SVGElement).style.fontFamily = 'CoroCJK';
        text.setAttribute('fill', '#111111');
      }
      for (const path of system.querySelectorAll('path'))
        if (!path.getAttribute('fill') || path.getAttribute('fill') !== 'none')
          path.setAttribute('fill', '#111111');
      await svg2pdf(system, pdf, {
        x: 12,
        y,
        width: renderWidth,
        height,
        loadImages: false,
        loadExternalStyleSheets: false,
      });
      y += height + 7;
    }
    const pages = pdf.getNumberOfPages();
    for (let page = 1; page <= pages; page++) {
      pdf.setPage(page);
      pdf.setFont('CoroCJK', 'normal');
      pdf.setFontSize(7);
      pdf.setTextColor('#747d88');
      pdf.text(
        project.source.kind === 'demo'
          ? 'Coro original demo · Not an audio-transcription accuracy claim'
          : project.arrangement
            ? 'Coro vocal arrangement · Please review before rehearsal'
            : 'Coro score · Automatically transcribed material requires review',
        12,
        287,
      );
      pdf.text(`${page} / ${pages}`, 198, 287, { align: 'right' });
    }
    return new Uint8Array(pdf.output('arraybuffer'));
  } finally {
    holder.remove();
  }
}
