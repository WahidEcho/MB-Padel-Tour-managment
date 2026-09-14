import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeWav16, parsePack, parseWav, renderUtterance, silentWav, DEFAULT_GAP_MS, DEFAULT_LONG_GAP_MS, DEFAULT_TAIL_MS, type PackIndex } from "./pack";
import { fade, normalizeLoudness, prepareClip, trimSilence } from "./dsp";
import { PHRASES, VOICE_PACK } from "./phrases";

const RATE = 22050;

function tone(ms: number, amplitude = 8000): Int16Array {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * amplitude);
  return out;
}

function join(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function pack(clips: Record<string, Int16Array>): { wav: Uint8Array; index: PackIndex } {
  const index: PackIndex = { format: 1, pack: "test", sampleRate: RATE, provider: "test", voice: null, generatedAt: "", totalSamples: 0, wavHash: "", clips: {} };
  let at = 0;
  for (const [id, samples] of Object.entries(clips)) {
    index.clips[id] = [at, samples.length];
    at += samples.length;
  }
  index.totalSamples = at;
  return { wav: encodeWav16(join(...Object.values(clips)), RATE), index };
}

describe("WAV encoding", () => {
  it("writes a standard 16-bit mono header", () => {
    const wav = encodeWav16(new Int16Array([1, -2, 3]), RATE);
    const view = new DataView(wav.buffer);
    const text = (o: number) => String.fromCharCode(...wav.slice(o, o + 4));
    expect(text(0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 6);
    expect(text(8)).toBe("WAVE");
    expect(text(12)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint32(28, true)).toBe(RATE * 2);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(6);
    expect(wav.length).toBe(50);
  });

  it("reads back what it writes", () => {
    const samples = tone(50);
    const back = parseWav(encodeWav16(samples, RATE));
    expect(back.sampleRate).toBe(RATE);
    expect(Array.from(back.samples)).toEqual(Array.from(samples));
  });

  it("mixes stereo to mono and skips unknown chunks", () => {
    const frames = 4;
    const bytes = new Uint8Array(12 + 8 + 16 + 8 + 4 + 8 + frames * 4);
    const v = new DataView(bytes.buffer);
    const put = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    put(0, "RIFF");
    v.setUint32(4, bytes.length - 8, true);
    put(8, "WAVE");
    put(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 2, true);
    v.setUint32(24, 44100, true);
    v.setUint16(34, 16, true);
    put(36, "LIST");
    v.setUint32(40, 4, true);
    put(48, "data");
    v.setUint32(52, frames * 4, true);
    for (let f = 0; f < frames; f++) {
      v.setInt16(56 + f * 4, 100, true);
      v.setInt16(58 + f * 4, 300, true);
    }
    const wav = parseWav(bytes);
    expect(wav.sampleRate).toBe(44100);
    expect(Array.from(wav.samples)).toEqual([200, 200, 200, 200]);
  });

  it("refuses what is not a WAV", () => {
    expect(() => parseWav(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toThrow();
  });
});

describe("rendering a call", () => {
  it("lays out lead-in, clips, pauses and tail", () => {
    const { wav, index } = pack({ game: tone(200), "games-1-0": tone(300), "pts-15-0": tone(250) });
    const voice = parsePack(wav, index);
    const out = renderUtterance(voice, ["game", "games-1-0", "pts-15-0"], { leadInMs: 300 });
    const ms = (n: number) => Math.round((n / 1000) * RATE);
    const expected =
      ms(300) + ms(200) + ms(DEFAULT_LONG_GAP_MS) + ms(300) + ms(DEFAULT_GAP_MS) + ms(250) + ms(DEFAULT_TAIL_MS);
    const samples = parseWav(out.wav).samples;
    expect(samples.length).toBe(expected);
    expect(out.missing).toEqual([]);
    // Silence first, then the first clip's audio exactly.
    expect(samples.slice(0, ms(300)).every((v) => v === 0)).toBe(true);
    expect(Array.from(samples.slice(ms(300), ms(300) + 20))).toEqual(Array.from(tone(200).slice(0, 20)));
    expect(out.durationMs).toBeGreaterThan(1500);
  });

  it("reports and skips clips the pack lacks", () => {
    const { wav, index } = pack({ game: tone(100) });
    const out = renderUtterance(parsePack(wav, index), ["game", "nope"], { leadInMs: 0, tailMs: 0 });
    expect(out.missing).toEqual(["nope"]);
    expect(parseWav(out.wav).samples.length).toBe(Math.round(0.1 * RATE));
  });

  it("refuses an index that does not match its audio", () => {
    const { wav, index } = pack({ game: tone(100) });
    expect(() => parsePack(wav, { ...index, sampleRate: 16000 })).toThrow();
    expect(() => parsePack(wav, { ...index, clips: { game: [0, 999999] } })).toThrow();
    // An index from another run, whose audio is a different length.
    expect(() => parsePack(wav, { ...index, totalSamples: index.totalSamples + 1 })).toThrow();
  });

  it("makes real silence for unlocking audio", () => {
    const s = parseWav(silentWav(60, RATE)).samples;
    expect(s.length).toBe(Math.round(0.06 * RATE));
    expect(s.every((v) => v === 0)).toBe(true);
  });
});

describe("clip clean-up", () => {
  it("trims silence around speech, keeping a little padding", () => {
    const clip = join(new Int16Array(RATE / 2), tone(200), new Int16Array(RATE / 2));
    const trimmed = trimSilence(clip, RATE, { padMs: 25 });
    expect(trimmed.length).toBeGreaterThanOrEqual(tone(200).length);
    expect(trimmed.length).toBeLessThan(tone(200).length + Math.round(0.08 * RATE));
    expect(trimSilence(new Int16Array(1000), RATE).length).toBe(0);
  });

  it("evens out loudness without clipping", () => {
    const quiet = normalizeLoudness(tone(200, 500));
    const loud = normalizeLoudness(tone(200, 30000));
    const peak = (s: Int16Array) => s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(Math.abs(peak(quiet) - peak(loud))).toBeLessThan(200);
    expect(peak(loud)).toBeLessThanOrEqual(Math.round(32767 * Math.pow(10, -1 / 20)) + 1);
  });

  it("fades both ends to silence", () => {
    const f = fade(tone(100, 20000).map(() => 20000), RATE, 5);
    expect(f[0]).toBe(0);
    expect(f[f.length - 1]).toBe(0);
    expect(f[Math.floor(f.length / 2)]).toBe(20000);
  });

  it("runs the whole clean-up on a clip with leading silence", () => {
    const clip = prepareClip(join(new Int16Array(2000), tone(150)), RATE);
    expect(clip.length).toBeGreaterThan(0);
    expect(clip.length).toBeLessThan(2000 + tone(150).length);
  });
});

describe("the committed voice pack", () => {
  const indexPath = fileURLToPath(new URL(`../../../public/voice/${VOICE_PACK}/pack.json`, import.meta.url));
  it.skipIf(!existsSync(indexPath))("holds every phrase the calls can ask for, from a voice cleared for use", () => {
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as PackIndex;
    expect(index.pack).toBe(VOICE_PACK);
    // The Mac's built-in voices are for personal use only, so never in a shipped pack.
    expect(index.provider).not.toBe("say");
    const missing = Object.keys(PHRASES).filter((id) => !index.clips[id]);
    expect(missing).toEqual([]);
    // The committed audio is the one this index describes.
    const wavPath = fileURLToPath(new URL(`../../../public/voice/${VOICE_PACK}/pack.wav`, import.meta.url));
    expect(() => parsePack(readFileSync(wavPath), index)).not.toThrow();
  });
});
