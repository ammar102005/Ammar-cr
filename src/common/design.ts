import { z } from 'zod';
export const FONTS = ['Amiri', 'Cairo', 'Tajawal', 'Playfair Display', 'Montserrat'] as const;
export const FIELDS = ['name', 'course', 'date', 'grade', 'issuer', 'id'] as const;
const n = (a: number, b: number) => z.number().min(a).max(b);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const base = { id: z.string().max(40), x: n(-200, 1323), y: n(-200, 994), w: n(4, 1400), h: n(4, 1000), lock: z.boolean().optional() };
export const Element = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('text'), text: z.string().max(500), font: z.enum(FONTS), size: n(6, 300), min: n(4, 300), color, align: z.enum(['left', 'center', 'right']), bold: z.boolean() }),
  z.object({ ...base, type: z.literal('rect'), stroke: color, sw: n(0, 60) }),
  z.object({ ...base, type: z.literal('img'), src: z.string().max(1_500_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/) }),
  z.object({ ...base, type: z.literal('qr') }),
]);
// schema version 1 — bump `v` and add a migrate() step when the format changes
export const Design = z.object({ v: z.literal(1), w: z.literal(1123), h: z.literal(794), bg: color, cl: z.enum(['ar', 'en']), els: z.array(Element).max(200) });
export type DesignT = z.infer<typeof Design>;
export type ElementT = z.infer<typeof Element>;
