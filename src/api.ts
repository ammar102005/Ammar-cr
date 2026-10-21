import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Header, HttpCode, Module, NotFoundException, Param, Post, Put, Req, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import { z } from 'zod';
import { AuthGuard, jobsQueue, jwt, ownedJob, ownedProject, parse, prisma, storage } from './common/infra';
import { Design, FIELDS } from './common/design';
import { MAX_ROWS, parseSheet, suggest, validate } from './common/sheet';

const Cred = z.object({ email: z.string().email().max(200).transform((s) => s.toLowerCase()), password: z.string().min(8).max(200) });
@Controller('auth')
class AuthController {
  @Post('register') async register(@Body() b: unknown) {
    const { email, password } = parse(Cred, b);
    if (await prisma.user.findUnique({ where: { email } })) throw new ConflictException('EMAIL_TAKEN');
    const u = await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash(password, 12) } });
    return { token: jwt.sign({ sub: u.id }, { expiresIn: '7d' }) };
  }
  @Post('login') @HttpCode(200) async login(@Body() b: unknown) {
    const { email, password } = parse(Cred, b);
    const u = await prisma.user.findUnique({ where: { email } });
    if (!u || !(await bcrypt.compare(password, u.passwordHash))) throw new BadRequestException('INVALID_CREDENTIALS');
    return { token: jwt.sign({ sub: u.id }, { expiresIn: '7d' }) };
  }
}

@Controller() @UseGuards(AuthGuard)
class ProjectsController {
  @Get('projects') list(@Req() r: any) { return prisma.project.findMany({ where: { ownerId: r.user.sub }, orderBy: { updatedAt: 'desc' } }); }
  @Post('projects') create(@Req() r: any, @Body() b: unknown) { const { name } = parse(z.object({ name: z.string().min(1).max(120) }), b); return prisma.project.create({ data: { name, ownerId: r.user.sub } }); }
  @Delete('projects/:id') async del(@Req() r: any, @Param('id') id: string) { await ownedProject(r.user.sub, id); await prisma.project.delete({ where: { id } }); storage.remove(`projects/${id}`); return { ok: true }; }
  @Get('projects/:id/design') async getDesign(@Req() r: any, @Param('id') id: string) { await ownedProject(r.user.sub, id); return (await prisma.design.findUnique({ where: { projectId: id } })) ?? null; }
  // Optimistic concurrency: client sends the revision it loaded; a stale save gets 409 instead of overwriting.
  @Put('projects/:id/design') async putDesign(@Req() r: any, @Param('id') id: string, @Body() b: any) {
    await ownedProject(r.user.sub, id);
    const data = parse(Design, b?.data), cur = await prisma.design.findUnique({ where: { projectId: id } });
    if (!cur) return prisma.design.create({ data: { projectId: id, data } });
    if (b.revision !== undefined && b.revision !== cur.revision) throw new ConflictException({ code: 'STALE_REVISION', revision: cur.revision });
    return prisma.design.update({ where: { projectId: id }, data: { data, revision: { increment: 1 } } });
  }
  @Post('projects/:id/import/preview') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5e6 } }))
  async preview(@Req() r: any, @Param('id') id: string, @UploadedFile() f: any) {
    await ownedProject(r.user.sub, id);
    const t = sheet(f);
    return { columns: t.cols, rowCount: t.rows.length, preview: t.rows.slice(0, 20), suggestedMapping: suggest(t.cols) };
  }
  @Get('projects/:id/jobs') async jobs(@Req() r: any, @Param('id') id: string) { await ownedProject(r.user.sub, id); return prisma.generationJob.findMany({ where: { projectId: id }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, total: true, done: true, failed: true, createdAt: true } }); }
  @Post('projects/:id/jobs') @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5e6 } }))
  async createJob(@Req() r: any, @Param('id') id: string, @UploadedFile() f: any, @Body() b: any) {
    await ownedProject(r.user.sub, id);
    const design = await prisma.design.findUnique({ where: { projectId: id } });
    if (!design) throw new BadRequestException('NO_DESIGN');
    const mapping = parse(z.record(z.enum(FIELDS), z.string()), safeJson(b.mapping));
    if (!mapping.name) throw new BadRequestException('NAME_MAPPING_REQUIRED');
    const formats = b.formats === 'pdf,png' ? ['pdf', 'png'] : ['pdf'];
    const { valid, rejected, longNames } = validate(sheet(f).rows, mapping);
    if (!valid.length) throw new BadRequestException({ code: 'NO_VALID_ROWS', rejected });
    const jobId = crypto.randomUUID(), used = new Set(valid.map((v) => v.fields.id).filter(Boolean));
    let seq = 0;
    const next = () => { let n; do n = String(++seq).padStart(4, '0'); while (used.has(n)); used.add(n); return n; };
    const recs = valid.map((v) => ({ id: crypto.randomUUID(), jobId, rowNo: v.rowNo, data: v.fields }));
    const certs = recs.map((rc, i) => ({ id: crypto.randomUUID(), recipientId: rc.id, token: crypto.randomBytes(9).toString('base64url'), number: valid[i].fields.id || next() }));
    // One transaction: job + recipients + certificate records are created together or not at all.
    await prisma.$transaction([
      prisma.generationJob.create({ data: { id: jobId, projectId: id, total: recs.length, designSnapshot: design.data as any, outputs: { formats } } }),
      prisma.recipient.createMany({ data: recs as any }),
      prisma.certificate.createMany({ data: certs }),
    ]);
    try { await jobsQueue.add('generate', { jobId }, { jobId, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true }); }
    catch { await prisma.generationJob.update({ where: { id: jobId }, data: { status: 'FAILED', error: 'QUEUE_UNAVAILABLE' } }); throw new BadRequestException('QUEUE_UNAVAILABLE'); }
    return { jobId, accepted: recs.length, rejected, longNames, maxRows: MAX_ROWS };
  }
}

@Controller() @UseGuards(AuthGuard)
class JobsController {
  @Get('jobs/:id') async get(@Req() r: any, @Param('id') id: string) { const j = await ownedJob(r.user.sub, id); const { designSnapshot, ...rest } = j; return rest; }
  @Get('jobs/:id/certificates') async certs(@Req() r: any, @Param('id') id: string) {
    await ownedJob(r.user.sub, id);
    return prisma.certificate.findMany({ where: { recipient: { jobId: id } }, select: { id: true, number: true, token: true, status: true, warning: true, recipient: { select: { rowNo: true, data: true } } }, take: 5000 });
  }
  @Post('jobs/:id/cancel') @HttpCode(200) async cancel(@Req() r: any, @Param('id') id: string) {
    const j = await ownedJob(r.user.sub, id);
    if (['QUEUED', 'RUNNING'].includes(j.status)) await prisma.generationJob.update({ where: { id }, data: { status: 'CANCELED' } });
    return { ok: true };
  }
  // Authenticated download (ownership re-checked on every request) — no guessable public file URLs.
  @Get('jobs/:id/files/:kind') async file(@Req() r: any, @Param('id') id: string, @Param('kind') kind: string, @Res({ passthrough: true }) res: any) {
    const j = await ownedJob(r.user.sub, id);
    if (kind !== 'pdf' && kind !== 'zip') throw new NotFoundException();
    const key = `jobs/${id}/certificates.${kind}`;
    if (!storage.exists(key) || (j.expiresAt && j.expiresAt < new Date())) throw new NotFoundException();
    res.set({ 'Content-Type': kind === 'pdf' ? 'application/pdf' : 'application/zip', 'Content-Disposition': `attachment; filename="certificates.${kind}"` });
    return new StreamableFile(fs.createReadStream(storage.path(key)));
  }
  @Post('certificates/:id/revoke') @HttpCode(200) async revoke(@Req() r: any, @Param('id') id: string, @Body() b: unknown) {
    const { revoked } = parse(z.object({ revoked: z.boolean() }), b);
    const c = await prisma.certificate.findFirst({ where: { id, recipient: { job: { project: { ownerId: r.user.sub } } } } });
    if (!c) throw new NotFoundException();
    return prisma.certificate.update({ where: { id }, data: { status: revoked ? 'REVOKED' : 'VALID', revokedAt: revoked ? new Date() : null }, select: { id: true, status: true } });
  }
}

// Public verification. Exposes only what the issuer shows on the certificate; the token is the only lookup key.
const hits = new Map<string, { n: number; t: number }>();
const limited = (ip: string) => { const now = Date.now(), h = hits.get(ip); if (!h || now - h.t > 60000) { hits.set(ip, { n: 1, t: now }); return false; } return ++h.n > 60; };
async function lookup(token: string) {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(token)) return null;
  const c = await prisma.certificate.findUnique({ where: { token }, include: { recipient: true } });
  if (!c) return null;
  const d = c.recipient.data as Record<string, string>;
  return { status: c.status, number: c.number, name: d.name, course: d.course, issuer: d.issuer, date: d.date };
}
const e = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
@Controller()
class VerifyController {
  @Get('verify/:token') @Header('Cache-Control', 'no-store') async api(@Req() r: any, @Param('token') t: string, @Res({ passthrough: true }) res: any) {
    if (limited(r.ip)) { res.status(429); return { status: 'RATE_LIMITED' }; }
    const v = await lookup(t); if (!v) { res.status(404); return { status: 'NOT_FOUND' }; } return v;
  }
  @Get('v/:token') @Header('Cache-Control', 'no-store') @Header('Content-Type', 'text/html; charset=utf-8') async page(@Req() r: any, @Param('token') t: string) {
    const ar = !/^en/i.test(r.headers['accept-language'] || 'ar'), v = limited(r.ip) ? null : await lookup(t);
    const L = ar ? { ok: 'شهادة صالحة', rv: 'شهادة ملغاة', nf: 'شهادة غير موجودة' } : { ok: 'Valid certificate', rv: 'Revoked certificate', nf: 'Certificate not found' };
    const [icon, title, col] = !v ? ['✕', L.nf, '#b91c1c'] : v.status === 'VALID' ? ['✓', L.ok, '#15803d'] : ['✕', L.rv, '#b91c1c'];
    return `<!doctype html><html lang="${ar ? 'ar' : 'en'}" dir="${ar ? 'rtl' : 'ltr'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(title)}</title><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px 16px"><div style="font-size:56px;color:${col}">${icon}</div><h1 style="color:${col}">${e(title)}</h1>${v ? `<p><b>${e(v.name)}</b></p><p>${e(v.course)}<br>${e(v.issuer)} · ${e(v.date)} · № ${e(v.number)}</p>` : ''}</body></html>`;
  }
}

function safeJson(s: unknown) { try { return JSON.parse(String(s)); } catch { throw new BadRequestException('BAD_MAPPING'); } }
function sheet(f: any) { if (!f) throw new BadRequestException('FILE_REQUIRED'); try { return parseSheet(f); } catch (err: any) { throw new BadRequestException(err.message); } }

@Module({ controllers: [AuthController, ProjectsController, JobsController, VerifyController], providers: [AuthGuard] })
export class AppModule {}
