/**
 * Builds the voice umpire's pack from the phrase inventory in src/lib/voice/phrases.ts.
 *
 *   npm run voice -- --provider say
 *       Development stand-in from this Mac's built-in voice, into public/voice/en-dev
 *       (gitignored). Apple licenses those voices for personal use only, so this
 *       pack is never committed or deployed.
 *
 *   npm run voice -- --list-voices
 *   npm run voice -- --audition <voiceId,voiceId,…> [--out <dir>]
 *       ElevenLabs: list the account's voices, or render one sample sentence per
 *       voice to choose from.
 *
 *   npm install --no-save kokoro-js@1.2.1
 *   npm run voice -- --provider kokoro [--voice am_michael]
 *       The released pack, into public/voice/<VOICE_PACK>: Kokoro-82M (Apache-2.0, free for
 *       commercial use), run on this Mac with no account or key. The voice chosen by
 *       the product owner is am_michael. kokoro-js is installed only for the run —
 *       it is ~400 MB and has no place in the app's own dependencies.
 *
 *   npm run voice -- --provider elevenlabs [--voice <voiceId>]
 *       The pack from ElevenLabs instead. Needs a paid plan, ELEVENLABS_API_KEY (and
 *       ELEVENLABS_VOICE_ID unless --voice is given) in .env.local. The key is read
 *       here on the Mac only; it is never sent to the app or the browser.
 *
 *   npm run voice -- --provider recordings --dir <folder>
 *       Human recordings named <clip id>.wav / .m4a / .mp3, one per line of the
 *       recording sheet (sheet.csv, written next to every pack).
 *
 * On Linux, where afconvert is missing, clips are converted with ffmpeg instead.
 *
 * Other flags: --pack <name>, --force (ignore the clip cache), --model <id>,
 * --overwrite (replace an existing pack folder other than en-dev).
 *
 * A released pack is cached by phones for a year and must never change. To try
 * voices or settings, build into en-dev (`--pack en-dev`), which is rebuilt in
 * place; to change a released pack, bump VOICE_PACK in phrases.ts.
 *
 * Every clip is fetched once and cached in voice-src/ (gitignored), as the
 * provider sent it, under a hash of the provider, voice and words: re-running only
 * fetches changed phrases, and changing the pack's sample rate fetches nothing.
 * Each clip is then converted on this Mac with afconvert (which decodes
 * ElevenLabs' MP3 and resamples with proper filtering) to 16-bit mono WAV, and
 * trimmed, levelled and joined.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEV_VOICE_PACK, PACK_SAMPLE_RATE, PHRASES, VOICE_PACK } from "../../src/lib/voice/phrases";
import { encodeWav16, parseWav, type PackIndex } from "../../src/lib/voice/pack";
import { prepareClip } from "../../src/lib/voice/dsp";

type Provider = "say" | "elevenlabs" | "kokoro" | "recordings";

const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
/** Unhurried, but faster than Kokoro's voices sound natural at below 0.9. */
const KOKORO_SETTINGS = { model: KOKORO_MODEL, dtype: "fp32", speed: 0.9 };
const DEFAULT_KOKORO_VOICE = "am_michael";

const ROOT = resolve(__dirname, "../..");
const ELEVEN = "https://api.elevenlabs.io/v1";
const DEFAULT_MODEL = "eleven_multilingual_v2";
/** Fixed, so a regenerated clip matches the clips around it as closely as the service allows. */
const SEED = 20260914;
/**
 * Slow and steady, as an umpire calls a score to a crowd: below normal speed, and
 * high stability so every clip has the same even delivery.
 */
const VOICE_SETTINGS = { stability: 0.75, similarity_boost: 0.8, style: 0, use_speaker_boost: true, speed: 0.85 };
/** Requests at once; ElevenLabs plans allow two to five, and a 429 is retried. */
const CONCURRENCY = 3;

const pause = (seconds: number) => ` <break time="${seconds}s" /> `;

/**
 * The words as sent to the voice: the recorded text with a real pause between the
 * two halves of a score, so "Fifteen … love" is never run together. One or two
 * breaks per clip at most — ElevenLabs gets unsteady with more.
 */
function spokenText(id: string, text: string): string {
  const twoWords = /^(pts|tb)-/.test(id) && id !== "pts-40-40";
  if (twoWords) return text.replace(/^(\S+) (\S+)$/, (_m, a: string, b: string) => `${a}${pause(0.45)}${b}`);
  if (id === "adv-server" || id === "adv-receiver") return text.replace(" ", pause(0.3));
  if (id === "game-set-match") return `Game,${pause(0.3)}set${pause(0.3)}and match.`;
  if (id === "game-set-match-named") return `Game,${pause(0.3)}set${pause(0.3)}and match,`;
  if (/^(games|sets)-\d+-\d+(-named)?$/.test(id)) return text.replace(/ to /, `${pause(0.3)}to `);
  return text;
}

/**
 * The words as sent to Kokoro, which has no break tags: whole phrases with a comma
 * where the pause goes ("Fifteen, love."), which keeps the voice's natural rise
 * and fall — splitting the words apart made it sound robotic.
 */
function kokoroText(id: string, text: string): string {
  if (/^(pts|tb)-/.test(id) && id !== "pts-40-40") return text.replace(/^(\S+) (\S+)$/, "$1, $2");
  if (id === "adv-server" || id === "adv-receiver") return text.replace(" ", ", ");
  if (id === "game-set-match") return "Game, set, and match.";
  if (id === "game-set-match-named") return "Game, set, and match,";
  if (/^(games|sets)-\d+-\d+(-named)?$/.test(id)) return text.replace(/ to /, ", to ");
  return text;
}

type KokoroEngine = {
  generate: (text: string, opts: { voice: string; speed: number }) => Promise<{ save: (path: string) => Promise<void> }>;
};
let kokoroEngine: Promise<KokoroEngine> | null = null;

/** Loads Kokoro once for the run. The module name is a variable: it is an optional, run-time-only install. */
function kokoro(): Promise<KokoroEngine> {
  if (!kokoroEngine) {
    const moduleName = "kokoro-js";
    kokoroEngine = import(moduleName)
      .catch(() => {
        throw new Error("Kokoro is not installed. Run: npm install --no-save kokoro-js@1.2.1");
      })
      .then((mod: { KokoroTTS: { from_pretrained: (model: string, opts: object) => Promise<KokoroEngine> } }) =>
        mod.KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: KOKORO_SETTINGS.dtype, device: "cpu" }),
      );
  }
  return kokoroEngine;
}

/** Silence between clips inside pack.wav, so the file can be listened to straight through. */
const FILE_GAP_SAMPLES = Math.round(PACK_SAMPLE_RATE * 0.05);

/**
 * Words spoken around a clip that is only part of a sentence, so the service
 * reads it with the right rise and fall. Never recorded themselves.
 */
function contextFor(id: string): { previous_text?: string; next_text?: string } {
  // Red and blue teams: a lead-in says a colour next; a named tally starts a new sentence after one.
  if (id === "team-red" || id === "team-blue" || id.startsWith("nation-")) return { previous_text: "Game," };
  if (id === "advantage" || /^(game|set|game-and-set|game-set-match)-named$/.test(id)) return { next_text: "Red team." };
  if (/^(games|sets)-\d+-\d+-named$/.test(id)) return { previous_text: "Game, Blue team.", next_text: "Blue team." };
  if (id === "leads-server" || id === "leads-receiver") return { next_text: "four games to two." };
  if (id.startsWith("games-") && !id.startsWith("games-all")) return { previous_text: "Game. Server leads" };
  if (id.startsWith("sets-") && !id.startsWith("sets-all")) return { previous_text: "Game and set. Receiver leads" };
  if (id === "games-to" || id === "game-to") return { previous_text: "Server leads eight", next_text: "seven." };
  if (id === "games-all") return { previous_text: "Eight" };
  if (id === "all") return { previous_text: "Nine" };
  if (id === "love") return { previous_text: "Server leads eight games to" };
  if (id.startsWith("n-")) return { next_text: "nine." };
  return {};
}

function args() {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    provider: get("provider") as Provider | undefined,
    pack: get("pack"),
    voice: get("voice"),
    model: get("model") ?? DEFAULT_MODEL,
    dir: get("dir"),
    out: get("out"),
    audition: get("audition"),
    listVoices: argv.includes("--list-voices"),
    force: argv.includes("--force"),
    overwrite: argv.includes("--overwrite"),
  };
}

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set in .env.local");
  return key;
}

/** Decodes a clip into 16-bit mono PCM at the pack's rate: afconvert on a Mac, ffmpeg elsewhere. */
function toPackSamples(input: string): Int16Array {
  const output = join(tmpdir(), `mb-voice-${createHash("sha1").update(input).digest("hex").slice(0, 12)}.wav`);
  if (process.platform === "darwin") {
    execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${PACK_SAMPLE_RATE}`, "-c", "1", input, output]);
  } else {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", input, "-ac", "1", "-ar", String(PACK_SAMPLE_RATE), "-c:a", "pcm_s16le", output]);
  }
  const wav = parseWav(readFileSync(output));
  rmSync(output, { force: true });
  if (wav.sampleRate !== PACK_SAMPLE_RATE) throw new Error(`afconvert gave ${wav.sampleRate} Hz for ${input}`);
  return wav.samples;
}

async function elevenlabs(text: string, voice: string, model: string, context: object): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${ELEVEN}/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": apiKey(), "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: model, voice_settings: VOICE_SETTINGS, seed: SEED, ...context }),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const detail = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 300)}`);
  }
}

/** One clip's source file: from the cache, or fetched into it. */
async function clipFile(
  provider: Provider,
  id: string,
  text: string,
  opts: { voice: string; model: string; dir?: string; force: boolean },
): Promise<string> {
  const context = provider === "elevenlabs" ? contextFor(id) : {};
  const settings = provider === "kokoro" ? KOKORO_SETTINGS : { model: opts.model, ...VOICE_SETTINGS, SEED };
  const key = createHash("sha1")
    .update(JSON.stringify({ provider, voice: opts.voice, text, context, settings }))
    .digest("hex")
    .slice(0, 16);
  const cacheDir = join(ROOT, "voice-src", provider);
  mkdirSync(cacheDir, { recursive: true });
  if (provider === "recordings") {
    if (!opts.dir) throw new Error("--dir is required for recordings");
    const source = readdirSync(opts.dir).find((f) => f.replace(/\.(wav|m4a|mp3|aiff?)$/i, "") === id);
    if (!source) throw new Error(`No recording for ${id} ("${text}") in ${opts.dir}`);
    return join(opts.dir, source);
  }
  const cached = join(cacheDir, `${id}.${key}.${provider === "say" ? "aiff" : provider === "kokoro" ? "wav" : "mp3"}`);
  if (existsSync(cached) && !opts.force) return cached;
  if (provider === "say") execFileSync("say", ["-v", opts.voice, "-o", cached, text]);
  else if (provider === "kokoro") {
    const audio = await (await kokoro()).generate(text, { voice: opts.voice, speed: KOKORO_SETTINGS.speed });
    await audio.save(cached);
  } else writeFileSync(cached, await elevenlabs(text, opts.voice, opts.model, context));
  return cached;
}

async function listVoices() {
  const res = await fetch(`${ELEVEN}/voices`, { headers: { "xi-api-key": apiKey() } });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { voices: { voice_id: string; name: string; labels?: Record<string, string> }[] };
  for (const v of body.voices) {
    const labels = Object.entries(v.labels ?? {})
      .map(([k, val]) => `${k}: ${val}`)
      .join(", ");
    console.log(`${v.voice_id}  ${v.name}${labels ? `  (${labels})` : ""}`);
  }
}

async function audition(voices: string[], model: string, out: string) {
  mkdirSync(out, { recursive: true });
  const sample = [
    spokenText("pts-15-0", "Fifteen love."),
    spokenText("pts-30-30", "Thirty all."),
    "Deuce.",
    spokenText("adv-receiver", "Advantage receiver."),
    "Break point.",
    "Game.",
    `Server leads ${spokenText("games-4-2", "four games to two.")}`,
    spokenText("game-set-match", "Game, set and match."),
  ].join(pause(0.8));
  for (const voice of voices) {
    const file = join(out, `audition-${voice}.mp3`);
    writeFileSync(file, await elevenlabs(sample, voice, model, {}));
    console.log(`wrote ${file}`);
  }
}

async function main() {
  const a = args();
  if (a.listVoices) return listVoices();
  if (a.audition) {
    return audition(a.audition.split(",").map((v) => v.trim()).filter(Boolean), a.model, resolve(a.out ?? join(ROOT, "voice-src", "audition")));
  }

  const provider = a.provider;
  if (provider !== "say" && provider !== "elevenlabs" && provider !== "kokoro" && provider !== "recordings") {
    throw new Error("Pass --provider kokoro | elevenlabs | recordings | say (or --list-voices / --audition)");
  }
  const pack = a.pack ?? (provider === "say" ? DEV_VOICE_PACK : VOICE_PACK);
  if (provider === "say" && pack === VOICE_PACK) {
    throw new Error(`The Mac's voices are for personal use only; build --provider say into ${DEV_VOICE_PACK}, not ${VOICE_PACK}`);
  }
  const voice =
    a.voice ??
    (provider === "say"
      ? "Daniel"
      : provider === "elevenlabs"
        ? process.env.ELEVENLABS_VOICE_ID ?? ""
        : provider === "kokoro"
          ? DEFAULT_KOKORO_VOICE
          : "recordings");
  if (provider === "elevenlabs" && !voice) throw new Error("Pass --voice <voiceId> or set ELEVENLABS_VOICE_ID");

  const outDir = join(ROOT, "public", "voice", pack);
  if (pack !== DEV_VOICE_PACK && existsSync(join(outDir, "pack.json")) && !a.overwrite) {
    throw new Error(
      `public/voice/${pack} already exists. A released pack must not change: bump VOICE_PACK for new recordings, ` +
        `build into --pack ${DEV_VOICE_PACK} to experiment, or pass --overwrite if ${pack} was never deployed.`,
    );
  }
  mkdirSync(outDir, { recursive: true });

  const entries = Object.entries(PHRASES);
  const chunks: Int16Array[] = [];
  const clips: PackIndex["clips"] = {};
  let cursor = 0;
  let done = 0;

  // Fetch every missing clip first, a few at a time; then assemble in inventory order.
  const files = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const [id, text] = entries[next++];
      const sent = provider === "elevenlabs" ? spokenText(id, text) : provider === "kokoro" ? kokoroText(id, text) : text;
      files.set(id, await clipFile(provider, id, sent, { voice, model: a.model, dir: a.dir, force: a.force }));
      if (++done % 20 === 0) console.log(`${done}/${entries.length} clips`);
    }
  };
  await Promise.all(Array.from({ length: provider === "elevenlabs" ? CONCURRENCY : 1 }, worker));

  for (const [id, text] of entries) {
    const file = files.get(id)!;
    const samples = prepareClip(toPackSamples(file), PACK_SAMPLE_RATE);
    if (samples.length === 0) throw new Error(`Clip ${id} ("${text}") came back silent`);
    clips[id] = [cursor, samples.length];
    chunks.push(samples, new Int16Array(FILE_GAP_SAMPLES));
    cursor += samples.length + FILE_GAP_SAMPLES;
  }

  const all = new Int16Array(cursor);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  const wav = encodeWav16(all, PACK_SAMPLE_RATE);
  const index: PackIndex = {
    format: 1,
    pack,
    sampleRate: PACK_SAMPLE_RATE,
    provider,
    voice,
    generatedAt: new Date().toISOString(),
    totalSamples: all.length,
    wavHash: createHash("sha256").update(wav).digest("hex").slice(0, 16),
    clips,
  };
  writeFileSync(join(outDir, "pack.wav"), wav);
  writeFileSync(join(outDir, "pack.json"), JSON.stringify(index));
  const csv = ["id,text", ...entries.map(([id, text]) => `${id},"${text.replace(/"/g, '""')}"`)].join("\n");
  writeFileSync(join(outDir, "sheet.csv"), `${csv}\n`);
  const seconds = cursor / PACK_SAMPLE_RATE;
  console.log(
    `Wrote public/voice/${pack}: ${entries.length} clips, ${seconds.toFixed(1)} s, ${((44 + cursor * 2) / 1048576).toFixed(1)} MB`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
