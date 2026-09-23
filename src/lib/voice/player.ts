"use client";

/**
 * Plays voice-umpire calls on the referee's phone.
 *
 * One audio element for the whole page, reused for every call:
 * - An iPhone lets an element play without a tap only once a tap has played it,
 *   and that permission stays with the element. So every referee tap "primes" it
 *   with a moment of real silence, and the call two seconds later is allowed.
 *   Android browsers only need an earlier tap anywhere on the page.
 * - A media element plays with an iPhone's silent switch on, unlike Web Audio,
 *   and goes wherever the phone's sound goes, a Bluetooth speaker included.
 *
 * Each call is rendered to a WAV in memory from the pack and played from a blob
 * URL, falling back to a data URI on the rare browser that refuses blob media.
 */
import { DEV_VOICE_PACK, PREVIOUS_VOICE_PACKS, VOICE_PACK, type ClipId } from "./phrases";
import { parsePack, renderUtterance, silentWav, type PackIndex, type VoicePack } from "./pack";

export type PackState = "ready" | "missing" | "error";
export type PlayResult = "played" | "blocked" | "interrupted" | "failed";

/** Fired on window for every call played, so a test can see what was said and when. */
export const VOICE_EVENT = "mb:voice";
export interface VoiceEventDetail {
  ids: ClipId[];
  at: number;
}

let element: HTMLAudioElement | null = null;
let objectUrl: string | null = null;
let silenceUri: string | null = null;
let blobRefused = false;
let loading: Promise<{ state: PackState; pack: VoicePack | null }> | null = null;

function audio(): HTMLAudioElement {
  if (!element) {
    element = new Audio();
    element.preload = "auto";
    element.setAttribute("playsinline", "");
  }
  return element;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}

function releaseUrl() {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

async function fetchPack(name: string): Promise<VoicePack | null> {
  const indexRes = await fetch(`/voice/${name}/pack.json`);
  if (indexRes.status === 404) return null;
  if (!indexRes.ok) throw new Error(`Voice pack index: ${indexRes.status}`);
  const index = (await indexRes.json()) as PackIndex;
  // Versioned by the index, so a cached index is always paired with its own audio.
  const wavRes = await fetch(`/voice/${name}/pack.wav?v=${encodeURIComponent(index.wavHash ?? "")}`);
  if (!wavRes.ok) throw new Error(`Voice pack audio: ${wavRes.status}`);
  return parsePack(await wavRes.arrayBuffer(), index);
}

/**
 * Downloads the pack once per page. The deployed pack is used when it exists, else
 * the last released one; in development the stand-in pack built from the Mac's
 * voice is the fallback.
 */
export function loadPack(): Promise<{ state: PackState; pack: VoicePack | null }> {
  if (!loading) {
    const attempt = (async () => {
      try {
        let pack = await fetchPack(VOICE_PACK);
        // The current pack not rendered yet: the last released one, without the newer calls.
        for (const older of PREVIOUS_VOICE_PACKS) pack ??= await fetchPack(older);
        if (!pack && process.env.NODE_ENV !== "production") pack = await fetchPack(DEV_VOICE_PACK);
        return pack ? { state: "ready" as const, pack } : { state: "missing" as const, pack: null };
      } catch {
        return { state: "error" as const, pack: null };
      }
    })();
    loading = attempt;
    // A failed download (no signal) is tried again next time rather than remembered.
    void attempt.then((r) => {
      if (r.state === "error" && loading === attempt) loading = null;
    });
  }
  return loading;
}

export function isPlaying(): boolean {
  return Boolean(element && !element.paused && !element.ended);
}

export function stop(): void {
  try {
    element?.pause();
  } catch {
    // Nothing to stop.
  }
}

/** Plays a moment of silence from inside a tap, so a later call may play. Leaves a call that is playing alone. */
export function prime(): void {
  try {
    if (isPlaying()) return;
    const el = audio();
    if (!silenceUri) silenceUri = `data:audio/wav;base64,${base64(silentWav(80, 16000))}`;
    releaseUrl();
    el.src = silenceUri;
    const started = el.play();
    if (started) started.catch(() => {});
  } catch {
    // Priming is best effort.
  }
}

function errorName(err: unknown): string {
  return err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "";
}

export async function play(pack: VoicePack, ids: ClipId[], leadInMs: number): Promise<PlayResult> {
  const { wav } = renderUtterance(pack, ids, { leadInMs });
  const el = audio();
  el.pause();
  window.dispatchEvent(new CustomEvent<VoiceEventDetail>(VOICE_EVENT, { detail: { ids, at: Date.now() } }));

  const start = async (src: string): Promise<PlayResult> => {
    el.src = src;
    try {
      await el.play();
      return "played";
    } catch (err) {
      const name = errorName(err);
      if (name === "NotAllowedError") return "blocked";
      // A newer tap paused it before it began: not a failure.
      if (name === "AbortError") return "interrupted";
      throw err;
    }
  };

  try {
    if (!blobRefused) {
      releaseUrl();
      objectUrl = URL.createObjectURL(new Blob([wav.buffer as ArrayBuffer], { type: "audio/wav" }));
      try {
        return await start(objectUrl);
      } catch {
        blobRefused = true;
      }
    }
    releaseUrl();
    return await start(`data:audio/wav;base64,${base64(wav)}`);
  } catch {
    return "failed";
  }
}
