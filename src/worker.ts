import { Worker } from 'bullmq';
import puppeteer, { Browser } from 'puppeteer-core';
import { PDFDocument } from 'pdf-lib';
import { ZipArchive } from 'archiver';
import fs from 'fs';
import { Design, DesignT } from './common/design';
import { Item, renderHtml } from './common/render';
import { PUBLIC_URL, prisma, redis, storage } from './common/infra';

const CHUNK = +(process.env.CHUNK_SIZE || 40), RETENTION_DAYS = +(process.env.RETENTION_DAYS || 7);
type Rec = { rowNo: number; data: any; certificate: { token: string; number: string } | null };

async function render(browser: Browser, d: DesignT, rs: Rec[], png: boolean) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: d.w, height: d.h, deviceScaleFactor: png ? 2 : 1 });
    const items: Item[] = rs.map((r) => ({ fields: { ...r.data, id: r.certificate!.number }, token: r.certificate!.token }));
    await page.setContent(await renderHtml(d, items, PUBLIC_URL), { waitUntil: 'load', timeout: 60000 });
    const warns = (await page.evaluate('window.__fit()')) as boolean[];
    const pdf = Buffer.from(await page.pdf({ width: `${d.w}px`, height: `${d.h}px`, printBackground: true, preferCSSPageSize: true }));
    if ((await PDFDocument.load(pdf)).getPageCount() !== rs.length) throw new Error('PAGE_COUNT_MISMATCH'); // never ship a PDF that drifted from the data
    const pngs: Buffer[] = [];
    if (png) for (const h of await page.$$('.cert')) pngs.push(Buffer.from(await h.screenshot({ type: 'png' })));
    return { pdf, pngs, warns };
  } catch (e: any) { console.error('render failed:', e.message); return null; } // log message only — no recipient data
  finally { await page.close(); }
}

async function run(jobId: string) {
  const job = await prisma.generationJob.findUnique({ where: { id: jobId } });
  if (!job || job.status === 'CANCELED') return;
  const design = Design.parse(job.designSnapshot), png = ((job.outputs as any)?.formats || []).includes('png');
  await prisma.generationJob.update({ where: { id: jobId }, data: { status: 'RUNNING', done: 0, failed: 0, error: null } });
  const recs = (await prisma.recipient.findMany({ where: { jobId }, orderBy: { rowNo: 'asc' }, include: { certificate: true } })) as Rec[];
  const merged = await PDFDocument.create(), failedRows: number[] = [];
  const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  let done = 0, canceled = false;
  try {
    for (let i = 0; i < recs.length; i += CHUNK) {
      if ((await prisma.generationJob.findUnique({ where: { id: jobId }, select: { status: true } }))?.status === 'CANCELED') { canceled = true; break; }
      const slice = recs.slice(i, i + CHUNK);
      let results: { rec: Rec; r: NonNullable<Awaited<ReturnType<typeof render>>> }[] = [];
      const whole = await render(browser, design, slice, png);
      if (whole) { // fast path: one render for the chunk, split pages back out per record
        const src = await PDFDocument.load(whole.pdf);
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
        slice.forEach((rec, k) => results.push({ rec, r: { pdf: whole.pdf, pngs: whole.pngs.slice(k, k + 1), warns: [whole.warns[k]] } }));
      } else { // isolate the bad record(s): one failing row must not lose the rest of the chunk
        for (const rec of slice) {
          const one = await render(browser, design, [rec], png);
          if (!one) { failedRows.push(rec.rowNo); continue; }
          const src = await PDFDocument.load(one.pdf); (await merged.copyPages(src, [0])).forEach((p) => merged.addPage(p));
          results.push({ rec, r: one });
        }
      }
      for (const { rec, r } of results) {
        if (png) storage.put(`jobs/${jobId}/png/${rec.rowNo}-${rec.certificate!.number.replace(/[^\w-]/g, '_')}.png`, r.pngs[0]);
        if (r.warns[0]) await prisma.certificate.update({ where: { token: rec.certificate!.token }, data: { warning: true } });
      }
      done += results.length;
      await prisma.generationJob.update({ where: { id: jobId }, data: { done, failed: failedRows.length } });
    }
  } finally { await browser.close(); }
  if (canceled) return;
  if (done > 0) {
    storage.put(`jobs/${jobId}/certificates.pdf`, Buffer.from(await merged.save()));
    if (png) await new Promise<void>((res, rej) => {
      const out = fs.createWriteStream(storage.path(`jobs/${jobId}/certificates.zip`)), z = new ZipArchive({ zlib: { level: 6 } });
      out.on('close', () => res()); z.on('error', rej); z.pipe(out); z.directory(storage.path(`jobs/${jobId}/png`), 'certificates'); z.finalize();
    });
    storage.remove(`jobs/${jobId}/png`);
  }
  await prisma.generationJob.update({ where: { id: jobId }, data: {
    status: done === 0 ? 'FAILED' : failedRows.length ? 'DONE_WITH_ERRORS' : 'DONE',
    outputs: { formats: png ? ['pdf', 'png'] : ['pdf'], pdf: done > 0, zip: png && done > 0, failedRows },
    expiresAt: new Date(Date.now() + RETENTION_DAYS * 864e5),
  } });
}

const worker = new Worker('generate', (j) => run(j.data.jobId), { connection: redis, concurrency: +(process.env.WORKER_CONCURRENCY || 1) });
worker.on('failed', async (j, err) => { // only mark FAILED once all retries are used up
  if (j && j.attemptsMade >= (j.opts.attempts || 1)) await prisma.generationJob.update({ where: { id: j.data.jobId }, data: { status: 'FAILED', error: err.message.slice(0, 200) } }).catch(() => {});
});
// Retention: purge expired output files.
setInterval(async () => {
  const old = await prisma.generationJob.findMany({ where: { expiresAt: { lt: new Date() }, NOT: { outputs: { equals: null as any } } }, select: { id: true } });
  for (const { id } of old) { storage.remove(`jobs/${id}`); await prisma.generationJob.update({ where: { id }, data: { outputs: { expired: true } } }); }
}, 3600e3);
console.log('worker ready');
