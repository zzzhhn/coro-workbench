// Engraving regression fixture: render ABC with the app's post-layout passes
// and report where each arpeggio line sits relative to its own chord.
import abcjs from 'abcjs';
import { alignEngravingArpeggios } from '../src/lib/engraving';

declare global { interface Window { arpeggioGeometry: (abc: string) => Array<{ arp: number[]; heads: number[]; visible: number }> } }

window.arpeggioGeometry = (abc) => {
  const el = document.getElementById('score')!;
  abcjs.renderAbc(el, abc, { add_classes: true, staffwidth: 860 });
  alignEngravingArpeggios([...el.querySelectorAll('svg')] as SVGSVGElement[]);
  return [...el.querySelectorAll('g.abcjs-note')].flatMap((note) => {
    const rect = (e: Element) => e.getBoundingClientRect();
    const segments = [...note.querySelectorAll('path[data-name="scripts.arpeggio"]')]
      .filter((e) => e.getAttribute('visibility') !== 'hidden').map(rect);
    const heads = [...note.querySelectorAll('.abcjs-notehead')].map(rect);
    if (!segments.length) return [];
    return [{ arp: [Math.min(...segments.map((r) => r.top)), Math.max(...segments.map((r) => r.bottom))],
              heads: [Math.min(...heads.map((r) => r.top)), Math.max(...heads.map((r) => r.bottom))],
              visible: segments.length }];
  });
};
document.body.dataset.ready = 'true';
