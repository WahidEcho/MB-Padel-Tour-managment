/**
 * Branded Excel files (owner's decision, 20 Oct 2026): every sheet a user downloads
 * starts with a navy band (Move Score's lockup on the left, the event's and the
 * organisation's logos and Move Beyond's on the right), the event's name on its colour,
 * the footer line, then the coloured header row, frozen under the band. The printed
 * page carries the event in its header and the footer line with page numbers.
 *
 * Call `brandSheet` after a sheet is filled (its data starting on row 1 with the header):
 * it inserts BRAND_ROWS rows above. Readers of our own files (the line-up sheet) find the
 * header row by its names, so the band changes nothing for them.
 */
import type ExcelJS from "exceljs";
import { BRAND, argb, textOn, type EventBrand } from "./brand";
import { imageBytes, type ImageBytes } from "./server";

/** Rows the band takes above a sheet's own header row. */
export const BRAND_ROWS = 3;

export interface BrandImages {
  lockup: number | null;
  moveBeyond: number | null;
  event: { id: number; w: number; h: number } | null;
  org: { id: number; w: number; h: number } | null;
}

function add(wb: ExcelJS.Workbook, img: ImageBytes | null): { id: number; w: number; h: number } | null {
  if (!img) return null;
  return { id: wb.addImage({ buffer: img.buffer as unknown as ExcelJS.Buffer, extension: img.extension }), w: img.width, h: img.height };
}

/** The logos, added to the workbook once (every sheet reuses them). */
export async function brandImages(wb: ExcelJS.Workbook, brand: EventBrand): Promise<BrandImages> {
  const [lockup, mb, ev, org] = await Promise.all([
    imageBytes(BRAND.lockup),
    imageBytes(BRAND.moveBeyondWhite),
    imageBytes(brand.eventLogo?.url, 160),
    imageBytes(brand.orgLogo?.url, 160),
  ]);
  return { lockup: add(wb, lockup)?.id ?? null, moveBeyond: add(wb, mb)?.id ?? null, event: add(wb, ev), org: add(wb, org) };
}

/** Approximate pixel width of the first n columns (Excel: ~7 px per character + padding). */
function columnsPx(ws: ExcelJS.Worksheet, n: number): number[] {
  const out: number[] = [];
  for (let c = 1; c <= n; c++) out.push(Math.round(((ws.getColumn(c).width ?? 13) * 7 + 5)));
  return out;
}

/** A pixel x position as ExcelJS's fractional column anchor. */
function colAt(widths: number[], x: number): number {
  let acc = 0;
  for (let i = 0; i < widths.length; i++) {
    if (x < acc + widths[i]) return i + (x - acc) / widths[i];
    acc += widths[i];
  }
  return widths.length;
}

/**
 * Brands one sheet: inserts the band, title and footer rows above row 1, colours the
 * header row (now row BRAND_ROWS + 1), freezes the panes under it and sets the printed
 * header and footer. `columns`: how many columns the sheet uses (at least 2).
 */
export function brandSheet(ws: ExcelJS.Worksheet, brand: EventBrand, images: BrandImages, opts: { title: string; columns?: number; headerRow?: boolean }) {
  const cols = Math.max(2, opts.columns ?? Math.max(ws.columnCount, 2));
  ws.spliceRows(1, 0, [], [], []);
  const navy = { type: "pattern", pattern: "solid", fgColor: { argb: argb(BRAND.navy) } } as ExcelJS.Fill;
  const primary = { type: "pattern", pattern: "solid", fgColor: { argb: argb(brand.primary) } } as ExcelJS.Fill;
  const band = ws.getRow(1);
  band.height = 40;
  const title = ws.getRow(2);
  title.height = 24;
  const foot = ws.getRow(3);
  foot.height = 16;
  for (let c = 1; c <= cols; c++) {
    band.getCell(c).fill = navy;
    title.getCell(c).fill = primary;
  }
  const head = [brand.eventName, brand.subtitle, opts.title].filter(Boolean).join(" · ");
  title.getCell(1).value = head;
  title.getCell(1).font = { bold: true, size: 14, color: { argb: argb(textOn(brand.primary)) } };
  title.getCell(1).alignment = { vertical: "middle" };
  foot.getCell(1).value = [BRAND.footer, brand.orgName && brand.orgName !== BRAND.maker ? `Organised by ${brand.orgName}` : null].filter(Boolean).join(" · ");
  foot.getCell(1).font = { italic: true, size: 9, color: { argb: argb(BRAND.muted) } };

  // Logos on the band (row 1 is 40 pt ≈ 53 px tall).
  const widths = columnsPx(ws, cols);
  const total = widths.reduce((a, b) => a + b, 0);
  const H = 34;
  const top = 0.18;
  if (images.lockup !== null) ws.addImage(images.lockup, { tl: { col: 0.05, row: top }, ext: { width: Math.round(H * BRAND.lockupAspect), height: H }, editAs: "oneCell" });
  let x = total - 8;
  const right = (img: { id: number; w: number; h: number } | null, h: number, id?: number | null, aspect?: number) => {
    const theId = img?.id ?? id;
    if (theId === null || theId === undefined) return;
    const w = Math.round(h * (img ? img.w / Math.max(1, img.h) : (aspect ?? 1)));
    x -= w;
    if (x < Math.round(H * BRAND.lockupAspect) + 16) return; // no room beside the lockup
    ws.addImage(theId, { tl: { col: colAt(widths, x), row: top }, ext: { width: w, height: h }, editAs: "oneCell" });
    x -= 12;
  };
  right(null, H, images.moveBeyond, BRAND.moveBeyondAspect);
  right(images.org, H);
  right(images.event, H);

  if (opts.headerRow !== false) {
    const hr = ws.getRow(BRAND_ROWS + 1);
    for (let c = 1; c <= cols; c++) {
      const cell = hr.getCell(c);
      cell.fill = navy;
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.border = { bottom: { style: "medium", color: { argb: argb(brand.accent) } } };
    }
  }
  ws.views = [{ state: "frozen", ySplit: BRAND_ROWS + (opts.headerRow !== false ? 1 : 0), xSplit: 0 }];
  const esc = (s: string) => s.replace(/&/g, "&&");
  ws.headerFooter = {
    oddHeader: `&L&"-,Bold"${esc(brand.eventName)}&R${esc(opts.title)}`,
    oddFooter: `&L${esc(BRAND.footer)}&RPage &P of &N`,
  };
  ws.pageSetup = { ...ws.pageSetup, orientation: cols > 6 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: `1:${BRAND_ROWS + 1}` };
}

/** Workbook properties every file carries. */
export function brandWorkbook(wb: ExcelJS.Workbook, brand: EventBrand) {
  wb.creator = `${BRAND.product} by ${BRAND.maker}`;
  wb.company = BRAND.maker;
  wb.title = brand.eventName;
  wb.created = new Date();
}
