import { describe, expect, it } from "vitest";
import {
  MAX_LUMINANCE_SHIFT,
  WATERMARK_BASE,
  bloomAlpha,
  composite,
  contrastRatio,
  hexToRgb,
  logoBox,
  markOpacity,
  relativeLuminance,
  resolveSponsors,
  sponsorStyle,
  surfaceForMode,
  tickerPlan,
  type WatermarkSurface,
} from "./sponsors";
import { imageDimensions } from "./upload";
import type { SponsorIntensity } from "./types";

const A = "https://x.supabase.co/storage/v1/object/public/media/a.png";
const B = "https://x.supabase.co/storage/v1/object/public/media/b.png";
const FRESH = "https://x.supabase.co/storage/v1/object/public/media/fresh.png";

describe("resolveSponsors", () => {
  it("reads the legacy URL list as unnamed footer sponsors", () => {
    expect(resolveSponsors({ sponsorLogoUrls: [A, B] })).toEqual({
      main: null,
      footer: [
        { name: "", logoUrl: A },
        { name: "", logoUrl: B },
      ],
    });
  });

  it("prefers the named list once it exists, even when it is empty", () => {
    expect(resolveSponsors({ sponsorLogoUrls: [A], sponsors: [] }).footer).toEqual([]);
    expect(resolveSponsors({ sponsorLogoUrls: [A], sponsors: [{ name: "Bee", logoUrl: B }] }).footer).toEqual([
      { name: "Bee", logoUrl: B },
    ]);
  });

  it("never also loops the main sponsor in the footer", () => {
    const r = resolveSponsors({
      mainSponsor: { name: "Fresh", logoUrl: FRESH, accentHex: "#00a651" },
      sponsorLogoUrls: [FRESH, A],
    });
    expect(r.main?.name).toBe("Fresh");
    expect(r.footer.map((s) => s.logoUrl)).toEqual([A]);
  });

  it("defaults the main sponsor's intensity, dashboard flag and a bad colour", () => {
    const r = resolveSponsors({ mainSponsor: { name: " Fresh ", logoUrl: FRESH, accentHex: "green" } });
    expect(r.main).toMatchObject({ name: "Fresh", accentHex: "#00aeef", intensity: "standard", showOnDashboard: true });
  });

  it("drops unsafe and duplicate logo URLs", () => {
    const r = resolveSponsors({
      sponsors: [
        { name: "js", logoUrl: "javascript:alert(1)" },
        { name: "data", logoUrl: "data:image/png;base64,AAAA" },
        { name: "one", logoUrl: A },
        { name: "again", logoUrl: A },
      ],
    });
    expect(r.footer).toEqual([{ name: "one", logoUrl: A }]);
  });

  it("ignores a main sponsor with no usable logo", () => {
    expect(resolveSponsors({ mainSponsor: { name: "Fresh", logoUrl: "", accentHex: "#00a651" } }).main).toBeNull();
  });
});

describe("watermark opacity", () => {
  it("is quietest behind a full grid of live courts", () => {
    expect(surfaceForMode("live", 4)).toBe("live_dense");
    expect(surfaceForMode("live", 3)).toBe("live_dense");
    expect(surfaceForMode("live", 2)).toBe("live_sparse");
    expect(surfaceForMode("leaderboard", 4)).toBe("board");
    expect(surfaceForMode("holding", 4)).toBe("slate");
    expect(surfaceForMode("ceremony", 1)).toBe("slate");
  });

  it("scales by intensity and never exceeds 0.3", () => {
    expect(markOpacity("live_dense", "subtle")).toBeCloseTo(0.033);
    expect(markOpacity("live_dense", "standard")).toBeCloseTo(0.06);
    expect(markOpacity("slate", "vivid")).toBeCloseTo(0.3);
    for (const s of Object.keys(WATERMARK_BASE) as WatermarkSurface[]) {
      for (const i of ["subtle", "standard", "vivid"] as SponsorIntensity[]) {
        expect(markOpacity(s, i)).toBeLessThanOrEqual(0.3);
      }
    }
  });
});

describe("luminance and contrast gates", () => {
  const BACKGROUNDS = { light: "#ffffff", dark: "#0b0b0b" };
  const CARDS = { light: "#f6f7f8", dark: "#161a1e" };
  const TEXT = { light: "#111111", dark: "#ffffff" };
  // A spread of real sponsor colours, including the awkward ones: a bright
  // green, a pale yellow that vanishes on white, a deep red, and pure white.
  const ACCENTS = ["#00a651", "#ffe600", "#c8102e", "#00aeef", "#ffffff", "#000000"];
  const surfaces = Object.keys(WATERMARK_BASE) as WatermarkSurface[];

  it("never lets the bloom move the background's luminance by more than 6%", () => {
    for (const bg of Object.values(BACKGROUNDS)) {
      for (const accent of ACCENTS) {
        for (const s of surfaces) {
          const a = bloomAlpha(bg, accent, markOpacity(s, "vivid") * 1.2);
          const shift = Math.abs(
            relativeLuminance(composite(hexToRgb(bg), hexToRgb(accent), a)) - relativeLuminance(hexToRgb(bg)),
          );
          expect(shift).toBeLessThanOrEqual(MAX_LUMINANCE_SHIFT + 1e-9);
        }
      }
    }
  });

  it("keeps the score at 7:1 or better over a live card, whatever glows behind it", () => {
    for (const theme of ["light", "dark"] as const) {
      const bg = hexToRgb(BACKGROUNDS[theme]);
      for (const accent of ACCENTS) {
        for (const s of ["live_dense", "live_sparse"] as const) {
          const o = markOpacity(s, "vivid");
          // Worst case under the card: the bloom at full strength, then the mark
          // itself in whichever of black or white fights the text hardest.
          const bloomed = composite(bg, hexToRgb(accent), bloomAlpha(BACKGROUNDS[theme], accent, o * 1.2));
          const marked = composite(bloomed, theme === "light" ? [0, 0, 0] : [255, 255, 255], o);
          const card = composite(marked, hexToRgb(CARDS[theme]), 0.86);
          expect(contrastRatio(hexToRgb(TEXT[theme]), card)).toBeGreaterThanOrEqual(7);
        }
      }
    }
  });
});

describe("footer loop", () => {
  it("sizes logos by area, so a wordmark does not outweigh a crest", () => {
    const crest = logoBox(1, 52);
    const wordmark = logoBox(4, 52);
    expect(crest.height).toBe(52);
    expect(wordmark.height).toBeLessThan(52);
    expect(wordmark.width * wordmark.height).toBeLessThan(crest.width * crest.height * 2.5);
  });

  it("gives an unknown logo a fixed 2:1 box, so the loop width is known before it loads", () => {
    expect(logoBox(undefined, 52)).toEqual(logoBox(2, 52));
  });

  it("holds enough copies that five logos on a 1920 wall never run dry", () => {
    const logos = Array.from({ length: 5 }, () => ({ aspect: 2 }));
    const plan = tickerPlan(logos, 1600, 52, 64);
    expect(plan.groupWidth * (plan.copies - 1)).toBeGreaterThanOrEqual(1600);
    expect(plan.copies).toBeGreaterThanOrEqual(2);
  });

  it("scrolls at a constant speed, not a constant duration", () => {
    const short = tickerPlan([{ aspect: 2 }], 1600, 52, 64);
    const long = tickerPlan(Array.from({ length: 12 }, () => ({ aspect: 2 })), 1600, 52, 64);
    expect(short.durationS).toBe(8);
    expect(long.groupWidth / long.durationS).toBeCloseTo(32);
  });

  it("is empty for no logos", () => {
    expect(tickerPlan([], 1600, 52, 64)).toEqual({ groupWidth: 0, copies: 0, durationS: 0 });
  });
});

describe("how the band draws its logos", () => {
  it("defaults to what every tournament had before the settings existed", () => {
    expect(sponsorStyle(undefined)).toEqual({ chips: true, uniform: false });
    expect(sponsorStyle({})).toEqual({ chips: true, uniform: false });
  });

  it("reads both switches", () => {
    expect(sponsorStyle({ sponsorChips: false })).toEqual({ chips: false, uniform: false });
    expect(sponsorStyle({ sponsorUniformSize: true })).toEqual({ chips: true, uniform: true });
  });

  it("gives every logo the same box in uniform mode, whatever its shape", () => {
    const crest = logoBox(1, 52, true);
    const wordmark = logoBox(6, 52, true);
    const unknown = logoBox(undefined, 52, true);
    expect(crest).toEqual(wordmark);
    expect(crest).toEqual(unknown);
    expect(crest.height).toBe(52);
  });

  it("changes the loop's arithmetic with it, so the band never runs dry in either mode", () => {
    const logos = [{ aspect: 1 }, { aspect: 4 }, { aspect: 2.5 }, {}];
    for (const uniform of [false, true]) {
      const plan = tickerPlan(logos, 1600, 52, 64, uniform);
      const measured = logos.reduce((sum, l) => sum + logoBox(l.aspect, 52, uniform).width + 64, 0);
      expect(plan.groupWidth).toBe(measured);
      expect(plan.groupWidth * (plan.copies - 1)).toBeGreaterThanOrEqual(1600);
    }
  });

  it("never distorts a logo: the box may change, the logo is contained in it", () => {
    // Every box stays inside the band's height, so a logo drawn to fit one is
    // never scaled past the row it sits in.
    for (const aspect of [0.4, 1, 2, 6, undefined]) {
      for (const uniform of [false, true]) {
        expect(logoBox(aspect, 52, uniform).height).toBeLessThanOrEqual(52);
      }
    }
  });
});

describe("imageDimensions", () => {
  it("reads a PNG header", () => {
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    b.set([0, 0, 0x03, 0x20, 0, 0, 0x01, 0x90], 16); // 800 x 400
    expect(imageDimensions(b)).toEqual({ width: 800, height: 400 });
  });

  it("reads a GIF header", () => {
    const b = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x40, 0x01, 0xa0, 0x00]);
    expect(imageDimensions(b)).toEqual({ width: 320, height: 160 });
  });

  it("walks JPEG segments to the frame header", () => {
    const b = new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0, length 4
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x04, 0xb0, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // SOF0 600h x 1200w
    ]);
    expect(imageDimensions(b)).toEqual({ width: 1200, height: 600 });
  });

  it("reads an extended WebP header", () => {
    const b = new Uint8Array(30);
    b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
    b.set([0x1f, 0x03, 0x00], 24); // 800 - 1
    b.set([0x8f, 0x01, 0x00], 27); // 400 - 1
    expect(imageDimensions(b)).toEqual({ width: 800, height: 400 });
  });

  it("reads an SVG viewBox", () => {
    const b = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100"></svg>');
    expect(imageDimensions(b, "image/svg+xml")).toEqual({ width: 300, height: 100 });
  });

  it("returns null for bytes it does not recognise", () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  });
});
