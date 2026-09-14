/**
 * The event background: what may be uploaded, how it is checked, and where it shows.
 * Pure, so the same rules run in the browser before an upload and on the server
 * after it.
 *
 * Files go straight from the organiser's browser to storage through a one-time
 * signed upload link, because a GIF or a video loop is far larger than a server
 * action accepts. The server then reads the first bytes of what actually arrived
 * and refuses anything that is not what it claims to be.
 *
 * SVG is markup, and markup can carry script. The wall and the public pages only
 * ever show it through an <img>, where script never runs — that is the real
 * protection. The file is also stripped of script and external references before
 * it is published, so opening its URL directly runs nothing either.
 */
import type { BackgroundDim, BrandingConfig, EventBackground } from "./types";

const MB = 1024 * 1024;

export interface BackgroundType {
  kind: EventBackground["kind"];
  ext: string;
  maxBytes: number;
  label: string;
}

/** Everything the uploader accepts, by MIME type. */
export const BACKGROUND_TYPES: Record<string, BackgroundType> = {
  "image/gif": { kind: "image", ext: "gif", maxBytes: 50 * MB, label: "GIF" },
  "image/webp": { kind: "image", ext: "webp", maxBytes: 30 * MB, label: "WebP" },
  "image/png": { kind: "image", ext: "png", maxBytes: 30 * MB, label: "PNG" },
  "image/jpeg": { kind: "image", ext: "jpg", maxBytes: 15 * MB, label: "JPEG" },
  "image/svg+xml": { kind: "svg", ext: "svg", maxBytes: 2 * MB, label: "SVG" },
  "video/mp4": { kind: "video", ext: "mp4", maxBytes: 50 * MB, label: "MP4 video" },
  "video/webm": { kind: "video", ext: "webm", maxBytes: 50 * MB, label: "WebM video" },
};

/** For the file picker. */
export const BACKGROUND_ACCEPT = Object.keys(BACKGROUND_TYPES).join(",");

export const BACKGROUND_DIMS: { value: BackgroundDim; label: string; percent: number }[] = [
  { value: "none", label: "None", percent: 0 },
  { value: "light", label: "Light", percent: 25 },
  { value: "medium", label: "Medium", percent: 45 },
  { value: "strong", label: "Strong", percent: 65 },
];

export const DEFAULT_DIM: BackgroundDim = "medium";

export function isBackgroundDim(value: unknown): value is BackgroundDim {
  return BACKGROUND_DIMS.some((d) => d.value === value);
}

/** How much of the page colour is laid over the background. */
export function dimPercent(dim: BackgroundDim | undefined): number {
  return BACKGROUND_DIMS.find((d) => d.value === dim)?.percent ?? 45;
}

/** Why a file cannot be used, before it is uploaded. Null when it can. */
export function backgroundProblem(file: { type: string; size: number }): string | null {
  const type = BACKGROUND_TYPES[file.type];
  if (!type) return "Upload a GIF, an animated SVG, WebP or PNG, a picture, or an MP4 or WebM video.";
  if (file.size <= 0) return "That file is empty.";
  if (file.size > type.maxBytes) {
    return `That ${type.label} is ${(file.size / MB).toFixed(1)} MB. The limit is ${Math.round(type.maxBytes / MB)} MB — export it smaller.`;
  }
  return null;
}

/** Where a tournament's backgrounds live in the media bucket. */
export function backgroundPrefix(tournamentId: string): string {
  return `branding/${tournamentId}/background/`;
}

export function backgroundPath(tournamentId: string, mime: string, stamp: string): string {
  return `${backgroundPrefix(tournamentId)}${stamp}.${BACKGROUND_TYPES[mime]?.ext ?? "bin"}`;
}

/** True when `path` is a background upload of this tournament that the server itself named. */
export function isBackgroundPath(tournamentId: string, path: string): boolean {
  const prefix = backgroundPrefix(tournamentId);
  if (!path.startsWith(prefix)) return false;
  return /^[a-z0-9-]{6,64}\.(gif|webp|png|jpg|svg|mp4|webm)$/.test(path.slice(prefix.length));
}

/**
 * The real type of the bytes, from their first few kilobytes. MOV and HEIC share
 * MP4's container, so their brands are refused by name: neither plays everywhere.
 */
export function sniffBackground(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i];
  const ascii = (start: number, len: number) => String.fromCharCode(...Array.from(bytes.slice(start, start + len)));
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && at(0) === 0x89 && ascii(1, 3) === "PNG" && at(4) === 0x0d && at(5) === 0x0a) return "image/png";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (bytes.length >= 4 && at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) return "video/webm";
  if (bytes.length >= 12 && ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4);
    if (["qt  ", "heic", "heix", "hevc", "mif1", "msf1", "avif", "crx "].includes(brand)) return null;
    return "video/mp4";
  }
  // SVG has no signature: markup whose first element is <svg>.
  const head = new TextDecoder().decode(bytes.slice(0, 4096)).replace(/^﻿/, "");
  const withoutPreamble = head.replace(/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?/i, "");
  if (/^<svg[\s>]/i.test(withoutPreamble)) return "image/svg+xml";
  return null;
}

/**
 * Removes what could run or reach out from an SVG: script, event handlers,
 * javascript: links, embedded HTML, and references to anything outside the file.
 * CSS and SMIL animation are kept, which is how animated SVGs normally move.
 */
export function sanitizeSvg(svg: string): { svg: string; removed: string[] } {
  const removed = new Set<string>();
  let out = svg;
  const strip = (pattern: RegExp, what: string) => {
    const next = out.replace(pattern, "");
    if (next !== out) removed.add(what);
    out = next;
  };
  // Every pattern runs in linear time: an unclosed element is removed to the end
  // of the file in one match, and attribute patterns take a single leading space,
  // so a crafted 2 MB file cannot make the server backtrack for minutes.
  strip(/<script\b(?:[\s\S]*?<\/script\s*>|[^>]*\/>|[\s\S]*$)/gi, "scripts");
  strip(/<foreignObject\b(?:[\s\S]*?<\/foreignObject\s*>|[\s\S]*$)/gi, "embedded HTML");
  strip(/<(iframe|embed|object|audio|video|link|meta)\b(?:[\s\S]*?(?:<\/\1\s*>|\/>)|[\s\S]*$)/gi, "embedded content");
  strip(/<\?xml-stylesheet(?:[^>]*>|[\s\S]*$)/gi, "external stylesheets");
  strip(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "event handlers");
  strip(/\s(?:xlink:)?href\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, "javascript links");
  // Only in-document references (#id) and inline data may stay.
  strip(/\s(?:xlink:)?href\s*=\s*("\s*(?!#|data:image\/)[^"]*"|'\s*(?!#|data:image\/)[^']*')/gi, "external references");
  strip(/@import[^;]*;?/gi, "external stylesheets");
  strip(/url\((?!\s*(?:['"]\s*)?(?:#|data:image\/))[^)]*\)?/gi, "external references");
  return { svg: out, removed: [...removed] };
}

/** The background a surface shows, or null. The public pages only when the organiser opted in. */
export function backgroundFor(branding: BrandingConfig | null | undefined, surface: "screen" | "public"): EventBackground | null {
  const bg = branding?.background;
  if (!bg?.url || !BACKGROUND_TYPES[bg.mime]) return null;
  if (surface === "public" && !bg.showOnPublic) return null;
  return { ...bg, dim: isBackgroundDim(bg.dim) ? bg.dim : DEFAULT_DIM };
}
