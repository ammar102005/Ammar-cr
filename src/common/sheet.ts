import * as XLSX from 'xlsx';
import { FIELDS } from './design';
export type Mapping = Partial<Record<(typeof FIELDS)[number], string>>;
const KW: Record<string, string[]> = { name: ['name', 'الاسم', 'اسم'], course: ['course', 'event', 'الدورة', 'دورة', 'الفعالية'], date: ['date', 'التاريخ', 'تاريخ'], grade: ['grade', 'rank', 'التقدير', 'تقدير', 'المركز'], issuer: ['issuer', 'organization', 'الجهة'], id: ['id', 'number', 'رقم', 'معرف'] };
export const MAX_ROWS = 5000;
export function parseSheet(file: { originalname: string; buffer: Buffer }) {
  const name = file.originalname.toLowerCase(), b = file.buffer;
  let wb: XLSX.WorkBook;
  if (name.endsWith('.csv')) wb = XLSX.read(b.toString('utf8').replace(/^\uFEFF/, ''), { type: 'string' }); // UTF-8 only, avoids Arabic mojibake
  else if (name.endsWith('.xlsx') && b[0] === 0x50 && b[1] === 0x4b) wb = XLSX.read(b, { type: 'buffer', cellDates: true }); // zip signature check
  else throw new Error('UNSUPPORTED_FILE');
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
  if (rows.length > MAX_ROWS) throw new Error('TOO_MANY_ROWS');
  return { cols: rows.length ? Object.keys(rows[0]) : [], rows };
}
export function suggest(cols: string[]): Mapping {
  const m: Mapping = {};
  for (const k of FIELDS) { const c = cols.find((c) => KW[k].some((w) => c.toLowerCase().includes(w))); if (c) m[k] = c; }
  return m;
}
export type Reject = { row: number; reason: 'EMPTY_ROW' | 'MISSING_NAME' | 'DUPLICATE_NUMBER' | 'TOO_LONG' };
export function validate(rows: Record<string, unknown>[], map: Mapping) {
  const valid: { rowNo: number; fields: Record<string, string> }[] = [], rejected: Reject[] = [], seen = new Set<string>();
  let longNames = 0;
  rows.forEach((r, i) => {
    const row = i + 2, f: Record<string, string> = {};
    for (const k of FIELDS) f[k] = map[k] ? String(r[map[k]!] ?? '').trim() : '';
    if (!Object.values(r).some((v) => String(v).trim())) return void rejected.push({ row, reason: 'EMPTY_ROW' });
    if (!f.name) return void rejected.push({ row, reason: 'MISSING_NAME' });
    if (Object.values(f).some((v) => v.length > 500)) return void rejected.push({ row, reason: 'TOO_LONG' });
    if (f.id) { if (seen.has(f.id)) return void rejected.push({ row, reason: 'DUPLICATE_NUMBER' }); seen.add(f.id); }
    if (f.name.length > 60) longNames++;
    valid.push({ rowNo: row, fields: f });
  });
  return { valid, rejected, longNames };
}
