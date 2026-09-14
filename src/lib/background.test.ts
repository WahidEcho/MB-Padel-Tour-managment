import { describe, expect, it } from "vitest";
import {
  backgroundFor,
  backgroundPath,
  backgroundProblem,
  dimPercent,
  isBackgroundPath,
  sanitizeSvg,
  sniffBackground,
} from "./background";
import type { EventBackground } from "./types";

const bytes = (...parts: (number[] | string)[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

describe("what can be uploaded", () => {
  it("accepts GIF, SVG, WebP, PNG, JPEG, MP4 and WebM within their limits", () => {
    expect(backgroundProblem({ type: "image/gif", size: 20 * 1024 * 1024 })).toBeNull();
    expect(backgroundProblem({ type: "image/svg+xml", size: 40_000 })).toBeNull();
    expect(backgroundProblem({ type: "video/mp4", size: 8 * 1024 * 1024 })).toBeNull();
    expect(backgroundProblem({ type: "video/webm", size: 1 })).toBeNull();
  });

  it("refuses other types, empty files and files over the limit", () => {
    expect(backgroundProblem({ type: "video/quicktime", size: 1000 })).toMatch(/GIF/);
    expect(backgroundProblem({ type: "image/gif", size: 0 })).toMatch(/empty/);
    expect(backgroundProblem({ type: "image/gif", size: 51 * 1024 * 1024 })).toMatch(/limit is 50 MB/);
    expect(backgroundProblem({ type: "image/svg+xml", size: 3 * 1024 * 1024 })).toMatch(/limit is 2 MB/);
  });
});

describe("recognising the bytes", () => {
  it("knows each accepted format by its signature", () => {
    expect(sniffBackground(bytes("GIF89a", [1, 0, 1, 0]))).toBe("image/gif");
    expect(sniffBackground(bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffBackground(bytes("RIFF", [0, 0, 0, 0], "WEBPVP8X"))).toBe("image/webp");
    expect(sniffBackground(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffBackground(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f]))).toBe("video/webm");
    expect(sniffBackground(bytes([0, 0, 0, 0x20], "ftypisom", [0, 0, 2, 0]))).toBe("video/mp4");
  });

  it("finds an SVG behind an XML declaration, comments and a doctype", () => {
    expect(sniffBackground(bytes('<?xml version="1.0"?>\n<!-- made with a tool -->\n<!DOCTYPE svg>\n<svg viewBox="0 0 1 1"/>'))).toBe("image/svg+xml");
    expect(sniffBackground(bytes('  <svg xmlns="http://www.w3.org/2000/svg">'))).toBe("image/svg+xml");
    expect(sniffBackground(bytes("<html><svg></svg></html>"))).toBeNull();
  });

  it("refuses MOV and HEIC, which share the MP4 container", () => {
    expect(sniffBackground(bytes([0, 0, 0, 0x14], "ftypqt  "))).toBeNull();
    expect(sniffBackground(bytes([0, 0, 0, 0x18], "ftypheic"))).toBeNull();
    expect(sniffBackground(bytes("plain text"))).toBeNull();
  });
});

describe("cleaning an SVG", () => {
  it("removes script, handlers, embedded HTML and outside references", () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert(2)</script>
      <foreignObject><iframe src="https://evil.example"></iframe></foreignObject>
      <a href="javascript:alert(3)"><rect/></a>
      <image href="https://tracker.example/pixel.png"/>
      <style>@import url(https://evil.example/x.css); .a { fill: url('https://evil.example/p.svg#g') }</style>
    </svg>`;
    const { svg, removed } = sanitizeSvg(dirty);
    expect(svg).not.toMatch(/script|onload|foreignObject|iframe|javascript:|tracker\.example|evil\.example/i);
    expect(removed).toEqual(expect.arrayContaining(["scripts", "event handlers", "embedded HTML", "external references", "external stylesheets"]));
  });

  it("keeps CSS and SMIL animation, gradients and inline references", () => {
    const clean = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <defs><linearGradient id="g"><stop offset="0" stop-color="#0f0"/></linearGradient></defs>
      <style>@keyframes spin { to { transform: rotate(360deg) } } .r { animation: spin 4s linear infinite; fill: url(#g) }</style>
      <circle class="r" r="10" fill="url('#g')"><animate attributeName="r" values="10;40;10" dur="3s" repeatCount="indefinite"/></circle>
      <use href="#g"/>
    </svg>`;
    const { svg, removed } = sanitizeSvg(clean);
    expect(removed).toEqual([]);
    expect(svg).toBe(clean);
  });
});

describe("cleaning a crafted SVG quickly", () => {
  it("stays fast on 2 MB inputs built to make the patterns backtrack", () => {
    const big = (unit: string) => `<svg>${unit.repeat(Math.ceil((2 * 1024 * 1024) / unit.length))}</svg>`;
    const inputs = [
      big(" "),
      big("\n\t"),
      big("url("),
      `<svg>url(${" ".repeat(2 * 1024 * 1024)}#g)</svg>`,
      big("<script "),
      big("<iframe "),
      big("<?xml-stylesheet"),
      big(" on"),
      big(" href="),
      `<svg> href${" ".repeat(2 * 1024 * 1024)}</svg>`,
      `<svg> onx${" ".repeat(2 * 1024 * 1024)}</svg>`,
    ];
    for (const input of inputs) {
      const started = performance.now();
      sanitizeSvg(input);
      expect(performance.now() - started, input.slice(0, 20)).toBeLessThan(1000);
    }
  });

  it("removes an unclosed script to the end of the file", () => {
    const { svg, removed } = sanitizeSvg('<svg><rect/><script>alert(1)');
    expect(svg).toBe("<svg><rect/>");
    expect(removed).toEqual(["scripts"]);
  });
});

describe("storage paths", () => {
  const tid = "3f6c2a1e-0000-4000-8000-000000000001";

  it("accepts only paths the server named, inside the tournament's own folder", () => {
    const path = backgroundPath(tid, "image/gif", "1789350000000-abc123");
    expect(path).toBe(`branding/${tid}/background/1789350000000-abc123.gif`);
    expect(isBackgroundPath(tid, path)).toBe(true);
    expect(isBackgroundPath("another-tournament", path)).toBe(false);
    expect(isBackgroundPath(tid, `branding/${tid}/background/../../players/x.gif`)).toBe(false);
    expect(isBackgroundPath(tid, `branding/${tid}/background/1789350000000-abc123.html`)).toBe(false);
  });
});

describe("where the background shows", () => {
  const bg: EventBackground = { url: "https://x/b.mp4", kind: "video", mime: "video/mp4", bytes: 10, dim: "strong", showOnPublic: false };

  it("always on the screens, and on the public pages only when chosen", () => {
    expect(backgroundFor({ background: bg }, "screen")?.url).toBe(bg.url);
    expect(backgroundFor({ background: bg }, "public")).toBeNull();
    expect(backgroundFor({ background: { ...bg, showOnPublic: true } }, "public")?.url).toBe(bg.url);
    expect(backgroundFor({}, "screen")).toBeNull();
  });

  it("falls back to medium darkening for an unknown setting", () => {
    expect(backgroundFor({ background: { ...bg, dim: "loud" as never } }, "screen")?.dim).toBe("medium");
    expect(dimPercent("none")).toBe(0);
    expect(dimPercent("strong")).toBe(65);
  });
});

describe("screens picking up a new background", () => {
  it("re-renders the wall when the tournament row changes, and not on a plain poll", async () => {
    const { needsStructuralRefresh } = await import("./tv/liveFeed");
    const screen = { revision: 3 } as never;
    const feed = (stamp: string | null) => ({ fetchedAt: 0, brandingStamp: stamp, screen, matches: [], snapshots: [] });
    expect(needsStructuralRefresh(feed("2026-09-14T10:00:00Z"), feed("2026-09-14T10:00:00Z"))).toBe(false);
    expect(needsStructuralRefresh(feed("2026-09-14T10:00:00Z"), feed("2026-09-14T10:05:00Z"))).toBe(true);
    // A feed from before the stamp existed is not a change.
    expect(needsStructuralRefresh({ ...feed(null), brandingStamp: undefined }, feed(null))).toBe(false);
  });
});
