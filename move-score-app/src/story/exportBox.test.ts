import { describe, expect, it } from "vitest";
import { captureSize, stickerBox } from "./exportBox";

describe("stickerBox", () => {
  it("centres a box bigger than the canvas on the sticker's point", () => {
    const b = stickerBox({ x: 0.5, y: 0.7, s: 1, r: 0 }, 360, 640);
    expect(b.width).toBe(1280);
    expect(b.height).toBe(1280);
    expect(b.left + b.width / 2).toBe(180);
    expect(b.top + b.height / 2).toBeCloseTo(448);
  });

  it("never gives the sticker a zero-size box", () => {
    const b = stickerBox({ x: 0, y: 1, s: 0.45, r: -0.06 }, 540, 960);
    expect(b.width).toBeGreaterThan(960);
    expect(b.transform).toEqual([{ rotate: "-0.06rad" }, { scale: 0.45 }]);
  });
});

describe("captureSize", () => {
  it("asks iOS for points so the file is 1080 × 1920 pixels", () => {
    expect(captureSize(1080, 1920, "ios", 3)).toEqual({ width: 360, height: 640 });
    expect(captureSize(1080, 1920, "ios", 2)).toEqual({ width: 540, height: 960 });
  });

  it("asks Android and the web for pixels", () => {
    expect(captureSize(1080, 1920, "android", 2.625)).toEqual({ width: 1080, height: 1920 });
    expect(captureSize(1080, 1920, "web", 2)).toEqual({ width: 1080, height: 1920 });
  });
});
