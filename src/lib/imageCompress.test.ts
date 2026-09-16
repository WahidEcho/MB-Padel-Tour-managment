import { describe, expect, it } from "vitest";
import {
  BACKGROUND_TARGET,
  DEFAULT_TARGET,
  MB,
  attemptPlan,
  describeShrink,
  fitWithin,
  isReEncodable,
  looksAnimated,
  outputType,
  renamed,
  shouldCompress,
} from "./imageCompress";

function bytes(text: string, length = text.length): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < text.length && i < length; i++) out[i] = text.charCodeAt(i);
  return out;
}

describe("what may be re-encoded", () => {
  it("takes the three still raster types", () => {
    expect(isReEncodable("image/jpeg")).toBe(true);
    expect(isReEncodable("image/png")).toBe(true);
    expect(isReEncodable("image/webp")).toBe(true);
  });

  it("leaves markup and animation alone", () => {
    expect(isReEncodable("image/svg+xml")).toBe(false);
    expect(isReEncodable("image/gif")).toBe(false);
    expect(isReEncodable("video/mp4")).toBe(false);
  });
});

describe("shouldCompress", () => {
  it("is false for a file already inside the limit", () => {
    expect(shouldCompress({ type: "image/jpeg", size: 2 * MB }, DEFAULT_TARGET)).toBe(false);
  });

  it("is true for a phone photo over it", () => {
    expect(shouldCompress({ type: "image/jpeg", size: 9 * MB }, DEFAULT_TARGET)).toBe(true);
  });

  it("is false for an oversized GIF, which would lose its animation", () => {
    expect(shouldCompress({ type: "image/gif", size: 40 * MB }, DEFAULT_TARGET)).toBe(false);
  });

  it("leaves a still background alone until its own larger limit", () => {
    expect(shouldCompress({ type: "image/png", size: 9 * MB }, BACKGROUND_TARGET)).toBe(false);
    expect(shouldCompress({ type: "image/png", size: 20 * MB }, BACKGROUND_TARGET)).toBe(true);
  });
});

describe("fitWithin", () => {
  it("keeps the shape", () => {
    expect(fitWithin(4000, 3000, 2400)).toEqual({ width: 2400, height: 1800 });
    expect(fitWithin(3000, 4000, 2400)).toEqual({ width: 1800, height: 2400 });
  });

  it("never enlarges", () => {
    expect(fitWithin(800, 600, 2400)).toEqual({ width: 800, height: 600 });
  });

  it("keeps at least one pixel on a very thin image", () => {
    expect(fitWithin(10000, 3, 2400)).toEqual({ width: 2400, height: 1 });
  });

  it("survives a zero", () => {
    expect(fitWithin(0, 0, 2400)).toEqual({ width: 0, height: 0 });
  });
});

describe("attemptPlan", () => {
  const plan = attemptPlan(DEFAULT_TARGET);

  it("starts at full size and the best quality", () => {
    expect(plan[0]).toEqual({ maxEdge: DEFAULT_TARGET.maxEdge, quality: 0.82 });
  });

  it("drops quality before it drops pixels", () => {
    const firstShrink = plan.findIndex((a) => a.maxEdge < DEFAULT_TARGET.maxEdge);
    expect(plan.slice(0, firstShrink).every((a) => a.maxEdge === DEFAULT_TARGET.maxEdge)).toBe(true);
    expect(firstShrink).toBe(4);
  });

  it("ends small enough for any phone photo to fit", () => {
    const last = plan[plan.length - 1];
    expect(last.maxEdge).toBe(600);
    expect(last.quality).toBe(0.42);
  });
});

describe("output naming", () => {
  it("keeps a JPEG a JPEG and sends everything else to WebP, which keeps transparency", () => {
    expect(outputType("image/jpeg")).toBe("image/jpeg");
    expect(outputType("image/png")).toBe("image/webp");
    expect(outputType("image/webp")).toBe("image/webp");
  });

  it("rewrites the extension so the server sees the type it is given", () => {
    expect(renamed("IMG_4821.HEIC.png", "image/webp")).toBe("IMG_4821.HEIC.webp");
    expect(renamed("logo.png", "image/jpeg")).toBe("logo.jpg");
    expect(renamed("no-extension", "image/webp")).toBe("no-extension.webp");
  });
});

describe("looksAnimated", () => {
  it("treats every GIF as animated", () => {
    expect(looksAnimated(bytes("GIF89a"), "image/gif")).toBe(true);
  });

  it("finds an animated WebP by its VP8X flag", () => {
    const b = bytes("RIFF____WEBPVP8X", 32);
    b[20] = 0x02;
    expect(looksAnimated(b, "image/webp")).toBe(true);
  });

  it("passes a still WebP", () => {
    const b = bytes("RIFF____WEBPVP8 ", 32);
    expect(looksAnimated(b, "image/webp")).toBe(false);
  });

  it("finds an APNG by acTL before IDAT, and ignores the word after IDAT", () => {
    expect(looksAnimated(bytes("\x89PNG\r\n\x1a\n....IHDR....acTL....IDAT"), "image/png")).toBe(true);
    expect(looksAnimated(bytes("\x89PNG\r\n\x1a\n....IHDR....IDAT....acTL"), "image/png")).toBe(false);
  });

  it("says nothing about a JPEG", () => {
    expect(looksAnimated(bytes("\xff\xd8\xff"), "image/jpeg")).toBe(false);
  });
});

describe("describeShrink", () => {
  it("reads in megabytes when it is megabytes", () => {
    expect(describeShrink(9 * MB, 2 * MB)).toBe("Compressed from 9.0 MB to 2.0 MB so it can be uploaded.");
  });

  it("drops to kilobytes for a small result", () => {
    expect(describeShrink(5 * MB, 250 * 1024)).toContain("to 250 KB");
  });
});
