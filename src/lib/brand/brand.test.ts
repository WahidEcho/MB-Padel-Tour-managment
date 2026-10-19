import { readFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { BRAND, argb, fileSlug, plainBrand, resolveEventBrand, textOn } from "./brand";
import { lineupTemplate } from "../tennis/lineupSheetServer";
import { readSheet } from "../tennis/lineupSheet";
import { BRAND_ROWS } from "./excel";

const S = "https://x.supabase.co/storage/v1/object/public/media/";

describe("an event's brand", () => {
  it("the group's name, the event's logo and colours, the organisation's logo, the sponsors", () => {
    const b = resolveEventBrand({
      tournament: {
        name: "Davis Cup Juniors",
        branding_config: { eventLogoUrl: `${S}event.png`, sponsors: [{ name: "Bank", logoUrl: `${S}bank.png` }, { name: "Bad", logoUrl: "javascript:alert(1)" }], mainSponsor: { name: "Main", logoUrl: `${S}main.png`, accentHex: "#ff0000" } },
        app_skin: { seedA: "#C8102E", seedB: null },
      },
      group: { name: "Junior Team Finals · Cairo 2026" },
      org: { name: "Egyptian Tennis Federation", slug: "etf", logo_url: `${S}etf.png`, colors: { primary: "#003366", accent: "#ffcc00" } },
    });
    expect(b.eventName).toBe("Junior Team Finals · Cairo 2026");
    expect(b.subtitle).toBe("Davis Cup Juniors");
    expect(b.eventLogo?.url).toBe(`${S}event.png`);
    expect(b.orgLogo?.url).toBe(`${S}etf.png`);
    expect(b.primary).toBe("#c8102e"); // the event's own skin wins over the organisation's
    expect(b.accent).toBe("#ffcc00");
    expect(b.sponsors.map((s) => s.name)).toEqual(["Main", "Bank"]); // main first, unsafe URLs dropped
  });
  it("Move Beyond's own events: no second Move Beyond logo; defaults are Move Score's", () => {
    const b = resolveEventBrand({ tournament: { name: "Padel Open", branding_config: { clientLogoUrl: `${S}mb.png` } }, org: { name: "Move Beyond", slug: "move-beyond", logo_url: `${S}mb.png` } });
    expect(b.orgLogo).toBeNull();
    expect(b.subtitle).toBeNull();
    expect(b.primary).toBe(BRAND.stage.toLowerCase());
    expect(plainBrand("X").sponsors).toEqual([]);
  });
  it("the footer line, colours and file names", () => {
    expect(BRAND.footer).toBe("Move Score by Move Beyond · tour.mbeg.org");
    expect(argb("#1e6bff")).toBe("FF1E6BFF");
    expect(textOn("#fcfc00")).toBe("#0b0e1f");
    expect(textOn("#01041a")).toBe("#ffffff");
    expect(fileSlug("Junior Team Finals · Cairo 2026")).toBe("junior-team-finals-cairo-2026");
  });
});

describe("branded files", () => {
  it("the line-up template: the band, the event, the footer line, then the header row (still read back)", async () => {
    const brand = resolveEventBrand({ tournament: { name: "Davis Cup Juniors" }, group: { name: "Junior Finals" } });
    const buf = await lineupTemplate([], "2026-10-30", brand);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet("Line-ups")!;
    expect(String(ws.getRow(2).getCell(1).value)).toContain("Junior Finals");
    expect(String(ws.getRow(3).getCell(1).value)).toContain(BRAND.footer);
    expect((ws.getRow(BRAND_ROWS + 1).values as unknown[]).slice(1, 3)).toEqual(["Day", "Event"]);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: BRAND_ROWS + 1 });
    expect(ws.getImages().length).toBeGreaterThanOrEqual(2); // Move Score and Move Beyond
    expect(ws.headerFooter.oddFooter).toContain("Move Score by Move Beyond");
    ws.getRow(BRAND_ROWS + 2).values = ["2026-10-30", "Boys", "Court 1", "09:30", "EGY", "ESP", "A", "B", "C", "D"];
    const grid: (string | null)[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      grid[n - 1] = (row.values as unknown[]).slice(1).map((v) => (v == null ? null : typeof v === "object" ? null : String(v)));
    });
    const read = readSheet(Array.from(grid, (r) => r ?? []));
    expect(read.error).toBeNull();
    expect(read.rows[0]).toMatchObject({ nationA: "EGY", s1a: "A" });
  });

  it("every printed page and exported workbook draws the brand", () => {
    const app = join(__dirname, "..", "..", "app");
    for (const f of ["qr/courts/page.tsx", "qr/coaches/page.tsx", "qr/match/[matchId]/page.tsx"]) {
      const src = readFileSync(join(app, f), "utf8");
      expect(src, f).toContain("<BrandBand");
      expect(src, f).toContain("<BrandFoot");
    }
    for (const f of ["api/tournaments/[id]/export/route.ts"]) expect(readFileSync(join(app, f), "utf8"), f).toContain("brandSheet(");
    expect(readFileSync(join(__dirname, "..", "tennis", "lineupSheetServer.ts"), "utf8")).toContain("brandSheet(");
    for (const f of ["qr/coaches/share/route.tsx", "qr/courts/share/route.tsx"]) expect(readFileSync(join(app, f), "utf8"), f).toContain("shareCardResponse(");
  });
});
