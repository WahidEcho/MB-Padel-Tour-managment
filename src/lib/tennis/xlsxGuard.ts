/**
 * A cap on what an uploaded .xlsx unpacks to, checked before ExcelJS parses it (audit
 * L6). An .xlsx is a zip; 2 MB on the wire can inflate to gigabytes (a zip bomb). Server
 * only (node:zlib). Every entry of the central directory is read and actually inflated
 * with a hard output cap, so a size the archive lies about cannot get past either.
 */
import { inflateRawSync } from "node:zlib";

export const XLSX_MAX_TOTAL = 20 * 1024 * 1024;
export const XLSX_MAX_ENTRY = 10 * 1024 * 1024;
export const XLSX_MAX_ENTRIES = 1000;

export type XlsxCheck = { ok: true; totalBytes: number } | { ok: false; reason: "not_zip" | "too_many_entries" | "too_big" | "unsupported" };

export function checkXlsxSize(input: ArrayBuffer | Uint8Array, caps = { total: XLSX_MAX_TOTAL, entry: XLSX_MAX_ENTRY, entries: XLSX_MAX_ENTRIES }): XlsxCheck {
  const buf = Buffer.from(input instanceof Uint8Array ? input : new Uint8Array(input));
  // End of central directory: the last 22 bytes plus a comment of up to 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return { ok: false, reason: "not_zip" };
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) return { ok: false, reason: "unsupported" }; // zip64
  if (count > caps.entries) return { ok: false, reason: "too_many_entries" };
  let p = cdOffset;
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return { ok: false, reason: "not_zip" };
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const declared = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    p += 46 + nameLen + extraLen + commentLen;
    if (compressed === 0xffffffff || declared === 0xffffffff || local === 0xffffffff) return { ok: false, reason: "unsupported" };
    if (declared > caps.entry) return { ok: false, reason: "too_big" };
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) return { ok: false, reason: "not_zip" };
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (dataStart + compressed > buf.length) return { ok: false, reason: "not_zip" };
    let actual: number;
    if (method === 0) actual = compressed;
    else if (method === 8) {
      try {
        actual = inflateRawSync(buf.subarray(dataStart, dataStart + compressed), { maxOutputLength: caps.entry }).length;
      } catch {
        return { ok: false, reason: "too_big" };
      }
    } else return { ok: false, reason: "unsupported" };
    total += Math.max(actual, declared);
    if (total > caps.total) return { ok: false, reason: "too_big" };
  }
  return { ok: true, totalBytes: total };
}
