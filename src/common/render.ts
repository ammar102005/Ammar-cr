import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import type { DesignT, ElementT } from './design';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const FONT_PKG: Record<string, { pkg: string; subs: string[] }> = {
  Amiri: { pkg: 'amiri', subs: ['latin', 'arabic'] }, Cairo: { pkg: 'cairo', subs: ['latin', 'arabic'] },
  Tajawal: { pkg: 'tajawal', subs: ['arabic'] }, 'Playfair Display': { pkg: 'playfair-display', subs: ['latin'] }, Montserrat: { pkg: 'montserrat', subs: ['latin'] },
};
const RANGE: Record<string, string> = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2212,U+FEFF',
  arabic: 'U+0600-06FF,U+0750-077F,U+0870-088E,U+0890-0891,U+0898-08E1,U+08E3-08FF,U+200C-200E,U+2010-2011,U+204F,U+2E41,U+FB50-FDFF,U+FE70-FE74,U+FE76-FEFC',
};
const b64 = new Map<string, string>();
function fontCss(families: Set<string>): string {
  let css = '';
  for (const fam of families) {
    const f = FONT_PKG[fam]; if (!f) continue;
    for (const sub of f.subs) for (const w of [400, 700]) { // latin declared first, arabic later so arabic wins overlapping ranges
      const file = path.join(process.cwd(), 'node_modules/@fontsource', f.pkg, 'files', `${f.pkg}-${sub}-${w}-normal.woff2`);
      let data = b64.get(file); if (!data) { data = fs.readFileSync(file).toString('base64'); b64.set(file, data); }
      css += `@font-face{font-family:'${fam}';font-weight:${w};src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${RANGE[sub]}}`;
    }
  }
  return css;
}
// Fit-to-box: shrink down to `min`, then wrap; flag the certificate if it still overflows the box.
const FIT = `window.__fit=async()=>{await document.fonts.ready;document.querySelectorAll('.t').forEach(b=>{const s=b.firstElementChild;let z=+b.dataset.size;const mn=Math.min(+b.dataset.min,z);b.style.fontSize=z+'px';s.style.whiteSpace='nowrap';const W=()=>s.getBoundingClientRect().width;while(W()>b.clientWidth+.5&&z>mn){z--;b.style.fontSize=z+'px'}if(W()>b.clientWidth+.5){s.style.whiteSpace='normal';if(s.getBoundingClientRect().height>b.clientHeight+.5)b.closest('.cert').dataset.warn='1'}});return[...document.querySelectorAll('.cert')].map(c=>c.dataset.warn==='1')}`;

export type Item = { fields: Record<string, string>; token: string };
const pos = (x: number, y: number, w: number, h: number) => `left:${x}px;top:${y}px;width:${w}px;height:${h}px`;
function el(e: ElementT, it: Item, qr?: string): string {
  if (e.type === 'rect') return `<div class="e" style="${pos(e.x - e.sw / 2, e.y - e.sw / 2, e.w + e.sw, e.h + e.sw)};border:${e.sw}px solid ${e.stroke}"></div>`;
  if (e.type === 'img') return `<img class="e" style="${pos(e.x, e.y, e.w, e.h)}" src="${e.src}">`;
  if (e.type === 'qr') return `<div class="e qr" style="${pos(e.x, e.y, e.w, e.h)};background:#fff">${qr ?? ''}</div>`;
  const txt = esc(e.text).replace(/\{(\w+)\}/g, (_, k) => esc(it.fields[k] ?? ''));
  const jc = { left: 'flex-start', center: 'center', right: 'flex-end' }[e.align];
  return `<div class="e t" data-size="${e.size}" data-min="${e.min}" style="${pos(e.x, e.y, e.w, e.h)};font-family:'${e.font}',sans-serif;font-weight:${e.bold ? 700 : 400};color:${e.color};font-size:${e.size}px;justify-content:${jc}"><span dir="auto">${txt}</span></div>`;
}
export async function renderHtml(d: DesignT, items: Item[], publicUrl: string): Promise<string> {
  const fams = new Set<string>(); d.els.forEach((e) => e.type === 'text' && fams.add(e.font));
  const hasQr = d.els.some((e) => e.type === 'qr');
  const qrs = hasQr ? await Promise.all(items.map((i) => QRCode.toString(`${publicUrl}/v/${i.token}`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }))) : [];
  const pages = items.map((it, i) => `<div class="cert" style="background:${d.bg}">${d.els.map((e) => el(e, it, qrs[i])).join('')}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss(fams)}@page{size:${d.w}px ${d.h}px;margin:0}*{box-sizing:border-box}body{margin:0}.cert{position:relative;width:${d.w}px;height:${d.h}px;overflow:hidden}.cert:not(:last-child){break-after:page}.e{position:absolute}.t{display:flex;align-items:center;direction:ltr;line-height:1.35}.qr svg{width:100%;height:100%;display:block}</style></head><body>${pages}<script>${FIT}</script></body></html>`;
}
