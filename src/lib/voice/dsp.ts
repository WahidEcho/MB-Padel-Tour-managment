/**
 * Clean-up applied to every clip when a voice pack is generated. Pure.
 *
 * Recorded or synthesised clips arrive with uneven silence around them and
 * uneven loudness. Joined into one call as they are, "Game." would come out
 * louder than "Server leads", and the gap between words would vary. Each clip is
 * trimmed to its speech, brought to one loudness, and faded at both ends so two
 * clips placed side by side never click.
 */

function dbToAmplitude(db: number): number {
  return 32767 * Math.pow(10, db / 20);
}

/** Cuts the silence before and after the speech, keeping `padMs` of it. */
export function trimSilence(
  samples: Int16Array,
  sampleRate: number,
  { thresholdDb = -42, padMs = 15 }: { thresholdDb?: number; padMs?: number } = {},
): Int16Array {
  const threshold = dbToAmplitude(thresholdDb);
  const windowSize = Math.max(1, Math.round(sampleRate * 0.01));
  const loud = (from: number) => {
    let peak = 0;
    for (let i = from; i < Math.min(samples.length, from + windowSize); i++) peak = Math.max(peak, Math.abs(samples[i]));
    return peak >= threshold;
  };
  let first = -1;
  for (let w = 0; w < samples.length; w += windowSize) {
    if (loud(w)) {
      first = w;
      break;
    }
  }
  if (first < 0) return new Int16Array(0);
  let last = first;
  for (let w = samples.length - (samples.length % windowSize || windowSize); w >= first; w -= windowSize) {
    if (loud(w)) {
      last = Math.min(samples.length, w + windowSize);
      break;
    }
  }
  const pad = Math.round((padMs / 1000) * sampleRate);
  return samples.slice(Math.max(0, first - pad), Math.min(samples.length, last + pad));
}

/** Scales a clip to a target loudness, never letting its peak pass `peakDb`. */
export function normalizeLoudness(
  samples: Int16Array,
  { targetRmsDb = -20, peakDb = -1 }: { targetRmsDb?: number; peakDb?: number } = {},
): Int16Array {
  if (samples.length === 0) return samples.slice();
  let sumSquares = 0;
  let peak = 0;
  for (const v of samples) {
    sumSquares += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms === 0 || peak === 0) return samples.slice();
  const gain = Math.min(dbToAmplitude(targetRmsDb) / rms, dbToAmplitude(peakDb) / peak);
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * gain)));
  return out;
}

/** Linear fade in and out over `ms` at each end. */
export function fade(samples: Int16Array, sampleRate: number, ms = 5): Int16Array {
  const out = samples.slice();
  const n = Math.min(Math.round((ms / 1000) * sampleRate), Math.floor(out.length / 2));
  for (let i = 0; i < n; i++) {
    const g = i / n;
    out[i] = Math.round(out[i] * g);
    out[out.length - 1 - i] = Math.round(out[out.length - 1 - i] * g);
  }
  return out;
}

/** The clean-up every clip goes through, in order. */
export function prepareClip(samples: Int16Array, sampleRate: number): Int16Array {
  return fade(normalizeLoudness(trimSilence(samples, sampleRate)), sampleRate);
}
