import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { deflateRawSync } from "node:zlib";
import { checkXlsxSize } from "./xlsxGuard";

/** A one-entry zip whose central directory may lie about the inflated size. */
function zipOf(name: string, data: Buffer, declared = data.length): Buffer {
  const comp = deflateRawSync(data);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(declared, 22);
  local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(comp.length, 20);
  cd.writeUInt32LE(declared, 24);
  cd.writeUInt16LE(n.length, 28);
  cd.writeUInt32LE(0, 42);
  const body = Buffer.concat([local, n, comp]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + n.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, cd, n, eocd]);
}

describe("checkXlsxSize (audit L6)", () => {
  it("passes a real workbook", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Line-ups").addRow(["Tie", "S1"]);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    expect(checkXlsxSize(bytes).ok).toBe(true);
  });
  it("refuses an entry that inflates past the cap, even when the archive says it is small", () => {
    const bomb = Buffer.alloc(12 * 1024 * 1024, 0x41); // 12 MB of 'A' deflates to a few KB
    const honest = zipOf("xl/worksheets/sheet1.xml", bomb);
    const lying = zipOf("xl/worksheets/sheet1.xml", bomb, 100);
    expect(honest.length).toBeLessThan(100_000);
    expect(checkXlsxSize(honest)).toEqual({ ok: false, reason: "too_big" });
    expect(checkXlsxSize(lying)).toEqual({ ok: false, reason: "too_big" });
  });
  it("refuses a total over the cap and a file that is no zip", () => {
    const part = zipOf("a.xml", Buffer.alloc(1024, 0x41));
    expect(checkXlsxSize(part, { total: 512, entry: 4096, entries: 10 })).toEqual({ ok: false, reason: "too_big" });
    expect(checkXlsxSize(Buffer.from("not a workbook"))).toEqual({ ok: false, reason: "not_zip" });
  });
});
