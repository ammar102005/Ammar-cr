import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import fs from 'fs';
import path from 'path';
import { BadRequestException, CanActivate, ExecutionContext, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ZodType } from 'zod';

export const prisma = new PrismaClient();
export const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
export const jobsQueue = new Queue('generate', { connection: redis });
export const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');

// Storage: local disk. Swap these three functions for an S3 client without touching callers.
const ROOT = path.resolve(process.env.STORAGE_DIR || './storage');
const safe = (key: string) => { if (!/^[\w./-]+$/.test(key) || key.includes('..')) throw new Error('bad key'); return path.join(ROOT, key); };
export const storage = {
  path: safe,
  put: (key: string, data: Buffer) => { const p = safe(key); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); },
  exists: (key: string) => fs.existsSync(safe(key)),
  remove: (prefix: string) => fs.rmSync(safe(prefix), { recursive: true, force: true }),
};

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) throw new Error('JWT_SECRET is required in production');
export const jwt = new JwtService({ secret: process.env.JWT_SECRET || 'dev-only-secret' });

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) throw new UnauthorizedException();
    try { req.user = jwt.verify(m[1]); } catch { throw new UnauthorizedException(); }
    return true;
  }
}
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}
// Server-side ownership checks — the UI hiding a button is never the access control.
export async function ownedProject(userId: string, id: string) {
  const p = await prisma.project.findFirst({ where: { id, ownerId: userId } });
  if (!p) throw new NotFoundException();
  return p;
}
export async function ownedJob(userId: string, id: string) {
  const j = await prisma.generationJob.findFirst({ where: { id, project: { ownerId: userId } } });
  if (!j) throw new NotFoundException();
  return j;
}
