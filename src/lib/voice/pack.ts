/**
 * The voice pack: every clip in one 16-bit mono WAV, plus an index of where each
 * clip starts. Pure byte handling, shared by the generator and the phone.
 *
 * Why uncompressed audio: building a call is then only copying samples and
 * writing a 44-byte header. There is no codec to decode, so an old Android phone
 * and a new iPhone produce the identical sound, and nothing here depends on Web
 * Audio, which an iPhone mutes when its silent switch is on.
 */
import { LONG_PAUSE_AFTER, pausesBeforeColour, type ClipId } from "./phrases";

export interface PackIndex {
  format: 1;
  pack: string;
  sampleRate: number;
  /** Which voice recorded it: "elevenlabs", "say" (development only) or "recordings". */
  provider: string;
  voice: string | null;
  generatedAt: string;
  /** Samples in pack.wav, so an index is never paired with another run's audio. */
  totalSamples: number;
  /** Short hash of pack.wav, used to version its URL next to this index. */
  wavHash: string;
  /** [first sample, sample count] of each clip inside pack.wav. */
  clips: Record<ClipId, [number, number]>;
}

export interface VoicePack {
  index: PackIndex;
  samples: Int16Array;
}

export interface Wav {
  sampleRate: number;
  /** Mono: several channels are averaged. */
  samples: Int16Array;
}

function ascii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/** Reads a PCM WAV (16-bit integer or 32-bit float). Throws on anything else. */
export function parseWav(input: ArrayBuffer | Uint8Array): Wav {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || ascii(view, 0, 4) !== "RIFF" || ascii(view, 8, 4) !== "WAVE") {
    throw new Error("Not a WAV file");
  }
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID.
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      if (!channels || !sampleRate) throw new Error("WAV data before its format");
      const available = Math.min(size, bytes.byteLength - body);
      const bytesPerSample = bits / 8;
      const frames = Math.floor(available / (bytesPerSample * channels));
      const samples = new Int16Array(frames);
      for (let f = 0; f < frames; f++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          const at = body + (f * channels + c) * bytesPerSample;
          if (format === 1 && bits === 16) sum += view.getInt16(at, true);
          else if (format === 3 && bits === 32) sum += Math.max(-1, Math.min(1, view.getFloat32(at, true))) * 32767;
          else throw new Error(`Unsupported WAV encoding (format ${format}, ${bits}-bit)`);
        }
        samples[f] = Math.round(sum / channels);
      }
      return { sampleRate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data");
}

/** A 16-bit mono PCM WAV. */
export function encodeWav16(samples: Int16Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(out.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return out;
}

/** Joins a pack's WAV with its index. Throws when they do not belong together. */
export function parsePack(wav: ArrayBuffer | Uint8Array, index: PackIndex): VoicePack {
  if (index.format !== 1) throw new Error("Unknown voice pack format");
  const parsed = parseWav(wav);
  if (parsed.sampleRate !== index.sampleRate) throw new Error("Voice pack sample rate does not match its index");
  if (parsed.samples.length !== index.totalSamples) throw new Error("Voice pack audio is not the one its index describes");
  for (const [start, length] of Object.values(index.clips)) {
    if (start < 0 || length < 0 || start + length > parsed.samples.length) {
      throw new Error("Voice pack index points past its audio");
    }
  }
  return { index, samples: parsed.samples };
}

export interface RenderOptions {
  /** Silence before the first word, so a Bluetooth speaker waking up does not swallow it. */
  leadInMs: number;
  /** Between clips of one sentence. */
  gapMs?: number;
  /** After "Game", "Correction" and the other clips that end a sentence. */
  longGapMs?: number;
  tailMs?: number;
}

export interface Utterance {
  wav: Uint8Array;
  /** Ids the pack does not hold; they are skipped. */
  missing: ClipId[];
  durationMs: number;
}

/**
 * Pauses between the parts of a call. Generous on purpose: a call is heard across
 * a court, over a Bluetooth speaker, by players catching their breath — unhurried
 * is clearer than quick.
 */
export const DEFAULT_GAP_MS = 300;
export const DEFAULT_LONG_GAP_MS = 600;
export const DEFAULT_TAIL_MS = 150;

function msToSamples(ms: number, sampleRate: number): number {
  return Math.max(0, Math.round((ms / 1000) * sampleRate));
}

/** One call as a playable WAV: lead-in, the clips with their pauses, a short tail. */
export function renderUtterance(pack: VoicePack, ids: ClipId[], opts: RenderOptions): Utterance {
  const rate = pack.index.sampleRate;
  const present = ids.filter((id) => pack.index.clips[id]);
  const missing = ids.filter((id) => !pack.index.clips[id]);
  const gap = msToSamples(opts.gapMs ?? DEFAULT_GAP_MS, rate);
  const longGap = msToSamples(opts.longGapMs ?? DEFAULT_LONG_GAP_MS, rate);

  const after = (i: number) =>
    LONG_PAUSE_AFTER.has(present[i]) || pausesBeforeColour(present[i], present[i + 1]) ? longGap : gap;

  let total = msToSamples(opts.leadInMs, rate) + msToSamples(opts.tailMs ?? DEFAULT_TAIL_MS, rate);
  present.forEach((id, i) => {
    total += pack.index.clips[id][1];
    if (i < present.length - 1) total += after(i);
  });

  const out = new Int16Array(total);
  let cursor = msToSamples(opts.leadInMs, rate);
  present.forEach((id, i) => {
    const [start, length] = pack.index.clips[id];
    out.set(pack.samples.subarray(start, start + length), cursor);
    cursor += length;
    if (i < present.length - 1) cursor += after(i);
  });
  return { wav: encodeWav16(out, rate), missing, durationMs: Math.round((total / rate) * 1000) };
}

/** Real silence. An iPhone only unlocks sound for a play that is not muted. */
export function silentWav(ms: number, sampleRate: number): Uint8Array {
  return encodeWav16(new Int16Array(msToSamples(ms, sampleRate)), sampleRate);
}
