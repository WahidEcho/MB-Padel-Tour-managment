/**
 * The story composer's data: what a share is about (a match, a tie or the pass),
 * the layout styles, and the maths that keeps a photo covering the 9:16 canvas.
 * Pure: no React, so the same numbers drive the screen and the 1080×1920 export.
 */
import type { MPass } from "@core";
import type { PassEvent } from "../ui/PassCard";
import { config } from "../config";

export type StoryKind = "match" | "tie" | "pass";
export type StoryStatus = "live" | "final" | "upcoming" | "here";

export interface StorySide {
  code: string;
  iso2: string | null;
  /** "USA", or the players' surnames for a rubber. */
  label: string;
  /** Finished sets, then the set in play (`games`), from this side's view. */
  sets: number[];
  games: number | null;
  won: boolean;
}

export interface StoryPass {
  pass: MPass;
  event: PassEvent;
  nationIso2: string | null;
}

export interface StoryInfo {
  kind: StoryKind;
  /** Tournament or event name. */
  event: string;
  /** "Final · S1", "Group A". */
  round: string | null;
  /** "Court 1 · Cairo". */
  place: string | null;
  city: string | null;
  /** "3 Oct 2026". */
  date: string;
  /** "Sat 3 Oct · 15:30" for something not on court yet. */
  when: string | null;
  status: StoryStatus;
  /** Two short words, drawn on two lines: ["Live", "now"]. */
  headline: [string, string];
  sides: [StorySide, StorySide] | null;
  /** "USA 2–1 FRA in the tie", "3 days on-site". */
  note: string | null;
  /** "No. 000123" on the pass, the ticket's serial otherwise. */
  serial: string;
  holder: string | null;
  /** The phone's pass for this event, when it has one: the "Pass" style uses it. */
  pass: StoryPass | null;
  /** One sentence for VoiceOver / TalkBack. */
  a11y: string;
}

export type LayoutId = "scoreboard" | "pass" | "minimal" | "ticket";
export type Tone = "dark" | "light";

export interface StickerPose {
  /** Centre, as a fraction of the canvas width and height. */
  x: number;
  y: number;
  /** Size, 1 = the sticker's own size. */
  s: number;
  /** Rotation, radians. */
  r: number;
}

export interface Layout {
  id: LayoutId;
  label: string;
  hint: string;
  pose: StickerPose;
}

/** Layout styles in rail order. The sticker starts where the layout puts it; the fan can move it. */
export const LAYOUTS: Layout[] = [
  { id: "scoreboard", label: "Scoreboard", hint: "A glass score sticker", pose: { x: 0.5, y: 0.7, s: 1, r: 0 } },
  { id: "pass", label: "Pass", hint: "Your event pass, foil and all", pose: { x: 0.5, y: 0.56, s: 0.94, r: -0.06 } },
  { id: "minimal", label: "Minimal", hint: "Just the words, big", pose: { x: 0.5, y: 0.66, s: 1, r: 0 } },
  { id: "ticket", label: "Ticket stub", hint: "A torn ticket stub", pose: { x: 0.5, y: 0.73, s: 1, r: -0.05 } },
];

/** The styles this story can use: "Pass" needs a pass for the event. */
export function layoutsFor(info: StoryInfo): Layout[] {
  return LAYOUTS.filter((l) => l.id !== "pass" || info.pass);
}

/** The design width every sticker is drawn at; a canvas of width W draws it at W / DESIGN_W. */
export const DESIGN_W = 360;
export const STORY_ASPECT = 16 / 9;
export const EXPORT_W = 1080;
export const EXPORT_H = 1920;

export interface Photo {
  uri: string;
  width: number;
  height: number;
}

export interface PhotoPose {
  /** Offset of the photo's centre from the canvas centre, as a fraction of the canvas width. */
  tx: number;
  ty: number;
  /** Zoom on top of "cover", 1 = just covers the canvas. */
  s: number;
}

export const PHOTO_MAX_ZOOM = 4;

/** The photo's size at zoom 1: the smallest size that covers a W×H canvas. */
export function coverSize(iw: number, ih: number, W: number, H: number): { w: number; h: number } {
  "worklet";
  if (!iw || !ih) return { w: W, h: H };
  const k = Math.max(W / iw, H / ih);
  return { w: iw * k, h: ih * k };
}

/** Keeps a zoomed photo covering the canvas: no edge ever shows. */
export function clampPhoto(p: PhotoPose, base: { w: number; h: number }, W: number, H: number): PhotoPose {
  "worklet";
  const s = Math.max(1, Math.min(PHOTO_MAX_ZOOM, p.s));
  const mx = Math.max(0, (base.w * s - W) / 2) / W;
  const my = Math.max(0, (base.h * s - H) / 2) / W;
  return { s, tx: Math.max(-mx, Math.min(mx, p.tx)), ty: Math.max(-my, Math.min(my, p.ty)) };
}

/** Where the photo sits on a W-wide canvas for a pose, as a plain box (no transforms, so every renderer agrees). */
export function photoBox(photo: Photo, pose: PhotoPose, W: number, H: number): { left: number; top: number; width: number; height: number } {
  const base = coverSize(photo.width, photo.height, W, H);
  const width = base.w * pose.s;
  const height = base.h * pose.s;
  return { width, height, left: W / 2 + pose.tx * W - width / 2, top: H / 2 + pose.ty * W - height / 2 };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Oct 2026", in the event's own time zone when it has one. */
export function storyDate(now: Date = new Date(), tz?: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short", year: "numeric" }).format(now);
  } catch {
    return `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  }
}

/** The days of an event, YYYY-MM-DD, at most two weeks. */
export function eventDays(a: string | null, b: string | null): string[] {
  if (!a) return [];
  const out: string[] = [];
  const end = Date.parse(`${b ?? a}T12:00:00Z`);
  for (let d = Date.parse(`${a}T12:00:00Z`); d <= end && out.length < 14; d += 86400000) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}

/** The app's page, printed small under the wordmark: "tour.mbeg.org/movescore". */
export function appLink(): string {
  return `${config.apiBaseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}/movescore`;
}

/** A ticket-style serial for stories that are not about the pass: stable per match or tie. */
export function serialOf(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `No. ${String(h % 1_000_000).padStart(6, "0")}`;
}

/** "Junior Team Finals" from "Junior Team Finals — Nations (Cairo 2026)": stickers have room for the name, not the subtitle. */
export function shortEvent(name: string): string {
  return name.split(/\s+[—–|]\s+/)[0]!.trim();
}

/** Set scores as one short line: "6 4 · 3". */
export function scoreText(side: StorySide): string {
  const sets = side.sets.join(" ");
  return side.games === null ? sets : sets ? `${sets} · ${side.games}` : String(side.games);
}
