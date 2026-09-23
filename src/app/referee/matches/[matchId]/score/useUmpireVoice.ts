"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ScoreState } from "@/lib/scoring/engine";
import type { ScoringConfig } from "@/lib/types";
import { callForTransition, classifyEvent, sameScore, supportedCall, type SideNames } from "@/lib/voice/calls";
import { TEST_CALL, TEST_CALL_COLOURED, captionFor, nationClip, type ClipId } from "@/lib/voice/phrases";
import type { VoicePack } from "@/lib/voice/pack";
import { loadPack, play, prime, stop, type PackState } from "@/lib/voice/player";

/* ---------------- per-phone settings ---------------- */

export interface VoiceSettings {
  enabled: boolean;
  /** How long after the last tap the score is called. */
  delayMs: number;
  /** Silence before the words, so a Bluetooth speaker that dozed off wakes in time. */
  leadInMs: number;
  /**
   * Silenced for now — during a changeover chat or a medical timeout — without
   * turning the voice off: the pack stays loaded and the next call after unmuting
   * plays as normal.
   */
  muted: boolean;
}

export const DELAY_OPTIONS = [1000, 2000, 3000];
export const LEAD_IN_OPTIONS = [0, 150, 300, 500];
const DEFAULTS: VoiceSettings = { enabled: false, delayMs: 2000, leadInMs: 300, muted: false };
const KEY = "mb_voice";
/** A timer that fires this much late (the phone was locked) calls a score nobody is waiting for. */
const STALE_MS = 3000;

const listeners = new Set<() => void>();
let memory: string | null = null;
let cachedRaw: string | null | undefined;
let cachedValue: VoiceSettings = DEFAULTS;

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY) ?? memory;
  } catch {
    // Storage blocked (a private window): the setting lasts for this page only.
    return memory;
  }
}

function parse(raw: string | null): VoiceSettings {
  if (!raw) return DEFAULTS;
  try {
    const v = JSON.parse(raw) as Partial<VoiceSettings>;
    return {
      enabled: v.enabled === true,
      delayMs: DELAY_OPTIONS.includes(Number(v.delayMs)) ? Number(v.delayMs) : DEFAULTS.delayMs,
      leadInMs: LEAD_IN_OPTIONS.includes(Number(v.leadInMs)) ? Number(v.leadInMs) : DEFAULTS.leadInMs,
      muted: v.muted === true,
    };
  } catch {
    return DEFAULTS;
  }
}

function snapshot(): VoiceSettings {
  const raw = readRaw();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedValue = parse(raw);
  }
  return cachedValue;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function save(next: VoiceSettings) {
  memory = JSON.stringify(next);
  try {
    localStorage.setItem(KEY, memory);
  } catch {
    // Kept in memory instead.
  }
  listeners.forEach((l) => l());
}

/* ---------------- the hook ---------------- */

export type VoiceStatus = "off" | "loading" | PackState | "blocked";

interface CallWindow {
  from: ScoreState;
  latest: ScoreState;
  /** Points and manual set ends minus undos since the window opened. */
  netPoints: number;
  /** The lowest `netPoints` reached: below zero, an undo reached past the last call. */
  lowestNet: number;
}

/** A tennis match's voice: the tennis calls, and the nations when it is a tie's rubber. */
export interface TennisVoice {
  /** ITF codes of the two sides, when they are nations. */
  nations?: { A: string | null; B: string | null };
}

/** The nation names for a pack, or null when either side has none in it. */
function nationNames(pack: VoicePack, tennis: TennisVoice | null): SideNames | null {
  const a = tennis?.nations?.A;
  const b = tennis?.nations?.B;
  if (!a || !b) return null;
  const names = { A: nationClip(a), B: nationClip(b) };
  return pack.index.clips[names.A] && pack.index.clips[names.B] ? names : null;
}

/**
 * The voice umpire for one scoring page. `onEvent` is called by the page for every
 * event it records, synchronously inside the referee's tap; everything else —
 * waiting, deciding the words, playing — happens here, and never throws back into
 * scoring.
 *
 * `active` is whether this page can score. A read-only page (another tablet holds
 * the match) never speaks, so it neither downloads the pack nor keeps the screen on.
 * `redBlue` is the organiser's red-and-blue-teams setting: calls then end in the
 * side's colour ("Advantage, Red team.") instead of "server" and "receiver".
 *
 * `tennis` adds the tennis calls (change of ends, deciding point, match tie-break)
 * and, for a nations tie, names the sides by nation ("Game, Romania."). Both need
 * a pack that holds them; with an older one the calls are said without them.
 */
export function useUmpireVoice(config: ScoringConfig, active: boolean, redBlue = false, tennis: TennisVoice | null = null) {
  const settings = useSyncExternalStore(subscribe, snapshot, () => DEFAULTS);
  const on = settings.enabled && active;
  const [packState, setPackState] = useState<PackState | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [caption, setCaption] = useState<string | null>(null);

  const onRef = useRef(on);
  const activeRef = useRef(active);
  const settingsRef = useRef(settings);
  const configRef = useRef(config);
  const redBlueRef = useRef(redBlue);
  const tennisRef = useRef(tennis);
  const [packName, setPackName] = useState<string | null>(null);
  useEffect(() => {
    tennisRef.current = tennis;
    redBlueRef.current = redBlue;
    onRef.current = on;
    activeRef.current = active;
    settingsRef.current = settings;
    configRef.current = config;
  });

  const windowRef = useRef<CallWindow | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Raised by every tap that changes the score: a call built before it is out of date. */
  const generationRef = useRef(0);
  const lockRef = useRef<WakeLockSentinel | null>(null);
  const lockPendingRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    windowRef.current = null;
    generationRef.current += 1;
  }, []);

  /**
   * Keeps the screen on: a locked phone stops the timer the call waits on. An
   * iPhone only grants this during a tap (or after one tap-time grant on the
   * page), so it is asked for from every tap as well as on load.
   */
  const ensureWakeLock = useCallback(() => {
    try {
      if (!onRef.current || !("wakeLock" in navigator)) return;
      if (document.visibilityState !== "visible" || lockPendingRef.current) return;
      if (lockRef.current && !lockRef.current.released) return;
      lockPendingRef.current = true;
      navigator.wakeLock
        .request("screen")
        .then((lock) => {
          // Turned off while the request was out.
          if (!onRef.current) {
            void lock.release().catch(() => {});
            return;
          }
          lockRef.current = lock;
        })
        .catch(() => {
          // Battery saver or no permission yet: the next tap asks again.
        })
        .finally(() => {
          lockPendingRef.current = false;
        });
    } catch {
      lockPendingRef.current = false;
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    const lock = lockRef.current;
    lockRef.current = null;
    if (lock && !lock.released) void lock.release().catch(() => {});
  }, []);

  // Download the pack as soon as the voice is on, so the first call is not late.
  useEffect(() => {
    if (!on) return;
    let alive = true;
    void loadPack().then((r) => {
      if (!alive) return;
      setPackState(r.state);
      if (r.pack) setPackName(r.pack.index.pack);
    });
    return () => {
      alive = false;
    };
  }, [on]);

  // Turning it off, or losing the match to another tablet, silences it at once.
  useEffect(() => {
    if (on) return;
    cancel();
    stop();
    releaseWakeLock();
  }, [on, cancel, releaseWakeLock]);

  useEffect(
    () => () => {
      cancel();
      stop();
      releaseWakeLock();
    },
    [cancel, releaseWakeLock],
  );

  // Best effort on load and on coming back to the page; enough on Android, and on
  // an iPhone once a tap has been granted the lock.
  useEffect(() => {
    if (!on) return;
    ensureWakeLock();
    const onVisibility = () => {
      if (document.visibilityState === "visible") ensureWakeLock();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [on, ensureWakeLock]);

  /** Plays the call `build` makes for the loaded pack, unless a newer tap has made it out of date. */
  const speak = useCallback(async (build: (pack: VoicePack) => ClipId[] | null, generation: number | null) => {
    const { pack, state } = await loadPack();
    setPackState(state);
    if (pack) setPackName(pack.index.pack);
    // A tap while the pack was still downloading makes this call out of date.
    if (!pack || (generation !== null && generation !== generationRef.current) || !onRef.current || settingsRef.current.muted) return;
    const ids = supportedCall(build(pack), (id) => Boolean(pack.index.clips[id]));
    if (!ids) return;
    const result = await play(pack, ids, settingsRef.current.leadInMs);
    if (result === "blocked") setBlocked(true);
    if (result === "played") {
      setBlocked(false);
      setCaption(captionFor(ids));
    }
  }, []);

  const onEvent = useCallback(
    (eventType: string, prev: ScoreState | null, next: ScoreState) => {
      try {
        if (!onRef.current) return;
        ensureWakeLock();
        const kind = classifyEvent(eventType);
        if (kind === "terminal") {
          cancel();
          stop();
          return;
        }
        // Undoing a pause, a server change or a confirmation leaves the board as it
        // was: that is not a correction of anything said.
        const boardUnchanged = eventType === "UNDO" && prev !== null && sameScore(prev, next);
        if (kind === "passive" || boardUnchanged) {
          // Updates what a pending call will read, but never restarts the wait or
          // cuts a call off.
          if (windowRef.current) windowRef.current = { ...windowRef.current, latest: next };
          prime();
          return;
        }

        // A new point: an umpire does not talk over play.
        stop();
        prime();
        generationRef.current += 1;
        const open = windowRef.current;
        const netPoints = (open?.netPoints ?? 0) + (eventType === "UNDO" ? -1 : 1);
        windowRef.current = {
          from: open?.from ?? prev ?? next,
          latest: next,
          netPoints,
          lowestNet: Math.min(open?.lowestNet ?? 0, netPoints),
        };

        if (timerRef.current) clearTimeout(timerRef.current);
        const delay = settingsRef.current.delayMs;
        const due = Date.now() + delay;
        const generation = generationRef.current;
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          const w = windowRef.current;
          windowRef.current = null;
          if (!w || document.hidden || Date.now() - due > STALE_MS) return;
          void speak(
            (pack) =>
              callForTransition(
                w.from,
                w.latest,
                {
                  corrects: w.lowestNet < 0,
                  netPoints: w.netPoints,
                  named: redBlueRef.current,
                  sides: nationNames(pack, tennisRef.current),
                  tennis: tennisRef.current !== null,
                },
                configRef.current,
              ),
            generation,
          );
        }, delay);
      } catch {
        // The voice must never get in the way of scoring.
      }
    },
    [cancel, speak, ensureWakeLock],
  );

  const setSettings = useCallback(
    (patch: Partial<VoiceSettings>) => {
      const next = { ...snapshot(), ...patch };
      save(next);
      settingsRef.current = next;
      // Muting cuts off a call that is already playing.
      if (next.muted) stop();
      // Ahead of the re-render, so the tap-time requests below see the new setting.
      onRef.current = next.enabled && activeRef.current;
      // Called from a tap: the moment to unlock sound and the screen lock for later.
      if (onRef.current) {
        prime();
        ensureWakeLock();
        void loadPack();
      }
    },
    [ensureWakeLock],
  );

  const test = useCallback(() => {
    prime();
    ensureWakeLock();
    // Not a new generation: a call waiting on its timer still plays, after the test.
    // Test plays even while muted — pressing it is asking to hear it.
    void (async () => {
      const { pack, state } = await loadPack();
      setPackState(state);
      if (pack) setPackName(pack.index.pack);
      if (!pack || !onRef.current) return;
      const call = redBlueRef.current ? TEST_CALL_COLOURED : TEST_CALL;
      const result = await play(pack, call, settingsRef.current.leadInMs);
      if (result === "blocked") setBlocked(true);
      if (result === "played") {
        setBlocked(false);
        setCaption(captionFor(call));
      }
    })();
  }, [ensureWakeLock]);

  /** A call of its own, outside the point-by-point flow: "Time." at the end of a changeover. */
  const say = useCallback(
    (ids: ClipId[]) => {
      if (!onRef.current) return;
      void speak(() => ids, null);
    },
    [speak],
  );

  const status: VoiceStatus = !on ? "off" : blocked ? "blocked" : packState ?? "loading";
  const nationsNamed = Boolean(tennis?.nations?.A && tennis?.nations?.B);

  return { settings, setSettings, status, caption, onEvent, test, say, redBlue, nationsNamed, packName };
}
