import { describe, it, expect } from "vitest";
import {
  deliveryWidth,
  focalPosition,
  portraitSrc,
  resolvePortrait,
  sizedImageSrc,
} from "./portrait";

const SUPA = "https://dwyztzywuscljqklhqij.supabase.co";
const ORIGINAL = `${SUPA}/storage/v1/object/public/media/players/abc-123.png`;

describe("resolvePortrait", () => {
  it("defaults to a face-height focal point when nothing is stored", () => {
    expect(resolvePortrait(null)).toEqual({
      photoUrl: null,
      portraitUrl: null,
      focalX: 0.5,
      focalY: 0.35,
    });
  });

  it("uses the row's own fields when there is no profile", () => {
    expect(resolvePortrait({ photo_url: "a.png", focal_y: 0.2 })).toMatchObject({
      photoUrl: "a.png",
      focalY: 0.2,
    });
  });

  it("a linked profile wins field by field", () => {
    const row = { photo_url: "row.png", focal_x: 0.1 };
    const profile = { photo_url: "profile.png" };
    expect(resolvePortrait(row, profile)).toMatchObject({ photoUrl: "profile.png", focalX: 0.1 });
  });

  it("a photoless profile never blanks the row's own photo", () => {
    const resolved = resolvePortrait({ photo_url: "row.png" }, { photo_url: null, focal_y: 0.4 });
    expect(resolved.photoUrl).toBe("row.png");
    expect(resolved.focalY).toBe(0.4);
  });

  it("treats an empty string as no photo", () => {
    expect(resolvePortrait({ photo_url: "" }).photoUrl).toBeNull();
  });

  it("clamps a focal point that escaped the frame", () => {
    expect(resolvePortrait({ focal_x: 1.8, focal_y: -3 })).toMatchObject({ focalX: 1, focalY: 0 });
    expect(resolvePortrait({ focal_x: Number.NaN }).focalX).toBe(0.5);
  });
});

describe("portraitSrc", () => {
  it("prefers the cut-out, falls back to the original, then nothing", () => {
    const base = { focalX: 0.5, focalY: 0.35 };
    expect(portraitSrc({ ...base, portraitUrl: "cut.png", photoUrl: "orig.jpg" })).toBe("cut.png");
    expect(portraitSrc({ ...base, portraitUrl: null, photoUrl: "orig.jpg" })).toBe("orig.jpg");
    expect(portraitSrc({ ...base, portraitUrl: null, photoUrl: null })).toBeNull();
  });
});

describe("focalPosition", () => {
  it("renders a CSS object-position", () => {
    expect(focalPosition({ focalX: 0.5, focalY: 0.35 })).toBe("50.0% 35.0%");
    expect(focalPosition({ focalX: 0, focalY: 1 })).toBe("0.0% 100.0%");
  });
});

describe("sizedImageSrc", () => {
  it("rewrites one of our public objects to the render endpoint", () => {
    expect(sizedImageSrc(ORIGINAL, 320)).toBe(
      `${SUPA}/storage/v1/render/image/public/media/players/abc-123.png?width=320&resize=contain&quality=80`,
    );
  });

  it("always asks for contain, never cover", () => {
    // cover with a width and no height keeps the original height and squashes
    // every face, so this is pinned rather than left to the endpoint default.
    expect(sizedImageSrc(ORIGINAL, 800)).toContain("resize=contain");
  });

  it("rounds the requested width", () => {
    expect(sizedImageSrc(ORIGINAL, 319.6)).toContain("width=320");
  });

  it("leaves anything that is not one of our public objects alone", () => {
    for (const url of [
      "https://example.com/someone.png",
      "data:image/png;base64,AAAA",
      "/local/relative.png",
      `${SUPA}/storage/v1/object/sign/media/private.png`,
      `${ORIGINAL}?token=abc`,
    ]) {
      expect(sizedImageSrc(url, 320)).toBe(url);
    }
  });

  it("returns null for a missing url", () => {
    expect(sizedImageSrc(null, 320)).toBeNull();
    expect(sizedImageSrc(undefined, 320)).toBeNull();
    expect(sizedImageSrc("", 320)).toBeNull();
  });
});

describe("deliveryWidth", () => {
  it("steps up with the box it has to fill", () => {
    expect(deliveryWidth(28)).toBe(160);
    expect(deliveryWidth(128)).toBe(320);
    expect(deliveryWidth(420)).toBe(800);
  });
});
