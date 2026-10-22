"use client";

/* eslint-disable @next/next/no-img-element -- local SVG flags and CDN-sized logos, drawn as they are */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Barlow_Condensed } from "next/font/google";
import { useAnchoredNow, useLiveFeed } from "@/components/broadcast/hooks";
import { flagSrc } from "@/components/tennis/Face";
import { logoBox } from "@/lib/sponsors";
import { sizedImageSrc } from "@/lib/portrait";
import type { LiveFeed } from "@/lib/tv/liveFeed";
import { OVERLAY_ALIVE_KEY, overlayModel, type OverlayModel, type OverlayOptions, type OverlayRow } from "@/lib/stream/overlay";
import { MOMENTUM_POINTS, boardStep, momentumGeometry, statBoxes, type BoardMemory, type BoardMode } from "@/lib/stream/board";
import type { OverlayMatchStats } from "@/lib/mobile/stats";
import type { OverlayLogo, OverlayProps } from "@/lib/stream/overlayServer";
import s from "./overlay.module.css";

const display = Barlow_Condensed({ subsets: ["latin", "latin-ext"], variable: "--ov-display", display: "block", weight: ["600", "700", "800"] });

/** The board's widths at 1920×1080: compact while play is on, full between games. */
const COMPACT_W = 600;
const FULL_W = 760;
/** The momentum line's drawing box (scaled to the card's width). */
const MOMENTUM_W = 520;
const MOMENTUM_H = 90;
/** The stats fetch waits this long after the score moves (and coalesces a burst). */
const STATS_MIN_GAP_MS = 600;
/** "Ace" stays in the strip this long after the ace lands (or until the next point). */
const ACE_MS = 6_000;
/** The footer loop's speed: one stage pixel per frame at 60 fps. */
const TICKER_PX_PER_S = 60;
const LOGO_H = 52;
const LOGO_PAD = 10;
const LOGO_GAP = 64;

const STAGE = { w: 1920, h: 1080 };
/** The safe margin from the frame's edges, and the sponsor loop's height (overlay.module.css). */
const SAFE = 48;
const FOOTER_H = 104;
const NATIVE = { w: STAGE.w, h: STAGE.h };

/** The browser source's size, outside React state, so a resize moves one transform. */
function useFrameSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [store] = useState(() => {
    let size = NATIVE;
    const ls = new Set<() => void>();
    return {
      set(w: number, h: number) {
        if (Math.abs(w - size.w) < 0.5 && Math.abs(h - size.h) < 0.5) return;
        size = { w, h };
        ls.forEach((l) => l());
      },
      subscribe(l: () => void) {
        ls.add(l);
        return () => ls.delete(l);
      },
      get: () => size,
    };
  });
  const size = useSyncExternalStore(store.subscribe, store.get, () => NATIVE);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => store.set(el.clientWidth, el.clientHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, store]);
  return size;
}

/**
 * A court's broadcast overlay, for an OBS browser source at 1920×1080. Polls the
 * venue screens' own live feed every second (a failed poll keeps the last good
 * frame) and draws the score bug and the sponsor loop on a transparent frame.
 */
export default function BroadcastOverlay({ props, options, initial }: { props: OverlayProps; options: OverlayOptions; initial: LiveFeed }) {
  const { feed, anchor } = useLiveFeed(props.slug, "main", { intervalMs: 1_000, initial });
  const now = useAnchoredNow(anchor, 250);
  // Tells the page's watchdog this client is alive and drawing (see OVERLAY_WATCHDOG).
  useEffect(() => {
    (window as unknown as Record<string, number>)[OVERLAY_ALIVE_KEY] = Date.now();
  }, [now]);
  const frame = useRef<HTMLDivElement>(null);
  const size = useFrameSize(frame);
  // Exactly 1 on a 1920×1080 source, so the bug is drawn pixel for pixel.
  const fit = Math.min(size.w / STAGE.w, size.h / STAGE.h);
  const current = feed ?? initial;
  const model = overlayModel({
    courtId: props.court.id,
    courtName: props.court.name,
    title: props.title,
    matches: current.matches,
    snapshots: current.snapshots,
    info: props.info,
    teams: props.teams,
    ties: props.ties,
    now: now || current.fetchedAt,
    switches: props.switches,
    timeZone: props.timeZone,
  });

  const footer = options.footer && props.sponsors.length > 0;
  return (
    <div ref={frame} className={s.frame} data-testid="broadcast-overlay" data-court={props.court.name} data-state={model.kind}>
      <div className={`${s.stage} ${display.variable}`} style={{ transform: `scale(${fit})` }}>
        {options.bug && (model.kind !== "idle" || options.idle) && (
          <div
            className={s.bugWrap}
            style={{
              transform: `scale(${options.scale})`,
              // Bottom left, inside the safe margins; above the sponsor loop when it runs.
              bottom: footer ? Math.round(FOOTER_H * options.scale) + 24 : SAFE,
            }}
          >
            <Bug model={model} now={now} slug={props.slug} />
          </div>
        )}
        {footer && (
          <div className={s.footer} style={{ transform: `scale(${options.scale})` }} data-testid="overlay-sponsors">
            <Ticker logos={props.sponsors} chips={props.chips} uniform={props.uniform} />
          </div>
        )}
      </div>
    </div>
  );
}

/** The ACE flash: from the moment this screen first sees the ace, for a few seconds. */
function useAceFlash(model: OverlayModel, now: number): boolean {
  const [seen, setSeen] = useState<{ key: string; at: number } | null>(null);
  const key = model.kind === "live" && model.ace ? `${model.matchId}:${model.eventNumber}` : null;
  if (key && seen?.key !== key && now > 0) setSeen({ key, at: now });
  return Boolean(key && seen?.key === key && now - seen.at < ACE_MS);
}

const sameMemory = (a: BoardMemory | null, b: BoardMemory | null) =>
  a === b || Boolean(a && b && a.matchId === b.matchId && a.scoreKey === b.scoreKey && a.gamesPlayed === b.gamesPlayed && a.gameWonAt === b.gameWonAt);

/** Compact or full, by the owner's rule (src/lib/stream/board.ts), remembered across frames. */
function useBoardMode(model: OverlayModel, now: number): BoardMode {
  const [memory, setMemory] = useState<BoardMemory | null>(null);
  const step = boardStep(memory, model, now);
  if (!sameMemory(step.memory, memory)) setMemory(step.memory);
  return step.mode;
}

/**
 * The momentum line and stat boxes of the match on the board, fetched when its
 * score moves (at most every STATS_MIN_GAP_MS). A failed fetch keeps the last.
 */
function useOverlayStats(slug: string, matchId: string | null, eventNumber: number): OverlayMatchStats | null {
  const [stats, setStats] = useState<OverlayMatchStats | null>(null);
  const key = matchId ? `${matchId}:${eventNumber}` : null;
  useEffect(() => {
    if (!matchId) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/t/${encodeURIComponent(slug)}/overlay-stats?match=${encodeURIComponent(matchId)}`, { cache: "no-store" });
        if (res.ok && !cancelled) setStats((await res.json()) as OverlayMatchStats);
      } catch {
        // The last good numbers stay.
      }
    }, STATS_MIN_GAP_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key carries matchId and eventNumber
  }, [slug, key]);
  return stats && stats.matchId === matchId ? stats : null;
}

/** The momentum line of the last 40 points: cyan above the midline (side A ahead), pink below (side B). */
function Momentum({ winners, codes }: { winners: ("A" | "B")[]; codes: [string, string] }) {
  const g = momentumGeometry(winners, MOMENTUM_W, MOMENTUM_H);
  return (
    <div className={s.momentum} data-testid="overlay-momentum">
      <svg viewBox={`0 0 ${MOMENTUM_W} ${MOMENTUM_H}`} role="img" aria-label="Momentum">
        <defs>
          <linearGradient id="ovMomFill" x1="0" y1="0" x2="0" y2={MOMENTUM_H} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#7cf6ff" stopOpacity=".45" />
            <stop offset=".5" stopColor="#7cf6ff" stopOpacity="0" />
            <stop offset=".5" stopColor="#ff6fb1" stopOpacity="0" />
            <stop offset="1" stopColor="#ff6fb1" stopOpacity=".45" />
          </linearGradient>
          <linearGradient id="ovMomLine" x1="0" y1="0" x2="0" y2={MOMENTUM_H} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#7cf6ff" />
            <stop offset=".5" stopColor="#7cf6ff" />
            <stop offset=".5" stopColor="#ff6fb1" />
            <stop offset="1" stopColor="#ff6fb1" />
          </linearGradient>
          <filter id="ovMomGlow" x="-10%" y="-40%" width="120%" height="180%">
            <feGaussianBlur stdDeviation="1.6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <line x1="0" y1={g.mid} x2={MOMENTUM_W} y2={g.mid} stroke="rgba(169,195,255,.4)" strokeWidth="1" strokeDasharray="4 4" />
        {winners.length > 0 && (
          <>
            <path d={g.area} fill="url(#ovMomFill)" />
            <path d={g.line} fill="none" stroke="url(#ovMomLine)" strokeWidth="2.6" strokeLinejoin="round" strokeLinecap="round" filter="url(#ovMomGlow)" />
            <circle cx={g.last[0]} cy={g.last[1]} r="4.6" fill="#fff" filter="url(#ovMomGlow)" />
          </>
        )}
      </svg>
      <div className={s.legend}>
        <span className={s.legendA}>{codes[0]} ahead ↑</span>
        <span>Last {MOMENTUM_POINTS} points</span>
        <span className={s.legendB}>↓ {codes[1]} ahead</span>
      </div>
    </div>
  );
}

/**
 * The "Momentum · neon" board, bottom left: a frosted deep-blue card with the
 * strip (live dot · event · round · court, and the moment or a timer on the
 * right), two rows (serve dot, flag, nation code, surnames, sets, games, points
 * in a cyan pill) and, on the full board, the momentum line and three stat boxes.
 * Compact while play is on, full between games and sets and at the end.
 */
function Bug({ model, now, slug }: { model: OverlayModel; now: number; slug: string }) {
  const ace = useAceFlash(model, now);
  const mode = useBoardMode(model, now);
  const scored = model.kind === "live" || model.kind === "final";
  const stats = useOverlayStats(slug, scored ? model.matchId : null, scored ? model.eventNumber : 0);
  if (model.kind === "idle") {
    return (
      <div className={`${s.card} ${s.idle}`} key="idle" data-testid="overlay-idle">
        <div className={s.hd} data-testid="overlay-header">
          <span className={s.hl}>{model.left.join(" · ")}</span>
        </div>
      </div>
    );
  }
  const final = model.kind === "final";
  const setCount = scored ? Math.max(model.rows[0].sets.length, model.rows[1].sets.length) : 0;
  const hasGames = model.kind === "live" && model.rows.some((r) => r.games !== null);
  const hasPoints = model.kind === "live";
  const codes = model.rows.every((r) => r.iso2);
  const cols = ["minmax(0, 1fr)", ...Array.from({ length: setCount }, () => "60px"), ...(hasGames ? ["60px"] : []), ...(hasPoints ? ["96px"] : [])];
  const compactW = COMPACT_W + Math.max(0, setCount + (hasGames ? 1 : 0) + (hasPoints ? 1 : 0) - 3) * 68;
  const full = mode === "full" && scored;
  const width = full ? Math.max(FULL_W, compactW) : compactW;
  const label = (r: OverlayRow) => (codes ? r.code : r.surnames[0] ?? r.code);
  const boxes = statBoxes(stats?.stats ?? null);

  const right = model.kind === "live" && model.clock
    ? (
        <span className={`${s.hr} ${model.clock.over ? s.hrOver : ""}`} data-testid="overlay-clock">
          {model.clock.label} <b className={s.num}>{model.clock.text}</b>
        </span>
      )
    : ace
      ? <span className={s.hr} data-testid="overlay-ace">Ace</span>
      : model.kind === "live" && model.paused
        ? <span className={`${s.hr} ${s.hrOver}`}>Play suspended</span>
        : model.right
          ? <span className={s.hr} data-testid={model.kind === "live" ? "overlay-callout" : undefined}>{model.right}</span>
          : null;

  const row = (r: OverlayRow, side: 0 | 1) => {
    const other = model.rows[side === 0 ? 1 : 0];
    const lost = final && !r.winner;
    return (
      <div className={`${s.row} ${lost ? s.lost : ""}`} style={{ gridTemplateColumns: cols.join(" ") }} key={side}>
        <div className={s.nm}>
          {r.serving ? <span className={s.srv} data-testid="overlay-serving" /> : <span className={s.gap} />}
          {flagSrc(r.iso2) && <img className={s.flag} src={flagSrc(r.iso2)!} alt="" />}
          {codes && <span className={s.code}>{r.code}</span>}
          <div className={`${s.who} ${codes ? "" : s.whoBig}`} data-testid="overlay-names">
            {r.surnames.map((n, i) => (
              <span key={i} className={r.servingIndex !== null && r.servingIndex !== i ? s.other : undefined}>
                {i > 0 ? " / " : ""}
                {n}
              </span>
            ))}
          </div>
          {r.winner && <span className={s.check} data-testid="overlay-winner">✓</span>}
        </div>
        {Array.from({ length: setCount }, (_, i) => {
          const x = r.sets[i];
          return (
            <span key={`s${i}`} className={`${s.n} ${s.num} ${x?.won ? s.win : ""}`} data-testid="overlay-set">
              {x?.games ?? ""}
              {x?.tb !== null && x?.tb !== undefined && <sup>{x.tb}</sup>}
            </span>
          );
        })}
        {hasGames && (
          <span className={`${s.n} ${s.num} ${(r.games ?? 0) >= (other.games ?? 0) ? s.win : ""}`} data-testid="overlay-games">
            <span key={r.games ?? "-"} className={s.pop}>{r.games ?? ""}</span>
          </span>
        )}
        {hasPoints && (
          <div className={`${s.p} ${s.num}`} data-testid="overlay-points">
            <span key={`${r.points}:${model.eventNumber}`} className={s.flip}>{r.points}</span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={`${s.card} ${full ? s.full : ""}`}
      style={{ width }}
      key={`${model.kind}:${model.matchId}`}
      data-testid="overlay-bug"
      data-match={model.matchId}
      data-mode={full ? "full" : "compact"}
    >
      <div className={s.hd} data-testid="overlay-header">
        <span className={s.hl}>
          {model.kind === "live" && <i className={s.dot} />}
          {/* A long event name gives way first; the round and the court always show. */}
          <span className={s.ev}>{model.left[0]}</span>
          {model.left.length > 1 && <span className={s.rest}>&nbsp;· {model.left.slice(1).join(" · ")}</span>}
        </span>
        {right}
      </div>
      {row(model.rows[0], 0)}
      {row(model.rows[1], 1)}
      {scored && (
        <div className={s.more} aria-hidden={!full}>
          <div className={s.moreIn}>
            <Momentum winners={stats?.momentum ?? []} codes={[label(model.rows[0]), label(model.rows[1])]} />
            {boxes.length > 0 && (
              <div className={s.stats} data-testid="overlay-stats">
                {boxes.map((b) => (
                  <div key={b.label}>
                    {b.label}
                    <b className={s.num}>{b.a} – {b.b}</b>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Every sponsor in one seamless loop. Each logo's box is known before it loads
 * (its shape is measured on upload), so one pass's width is arithmetic and the
 * track never changes size under the animation; enough copies fill 1920 px
 * plus one, so the seam is always off-frame.
 */
function Ticker({ logos, chips, uniform }: { logos: OverlayLogo[]; chips: boolean; uniform: boolean }) {
  const boxes = logos.map((l) => logoBox(l.aspect, LOGO_H, uniform));
  const groupWidth = boxes.reduce((sum, b) => sum + b.width + 2 * LOGO_PAD + LOGO_GAP, 0);
  if (groupWidth <= 0) return null;
  const copies = Math.max(2, Math.ceil(STAGE.w / groupWidth) + 1);
  const duration = Math.max(10, groupWidth / TICKER_PX_PER_S);
  return (
    <div className={s.viewport}>
      <div
        className={s.track}
        style={{ animationDuration: `${duration}s`, ["--ov-shift" as string]: `-${groupWidth}px` } as React.CSSProperties}
      >
        {Array.from({ length: copies }, (_, copy) => (
          <div key={copy} className={s.group} aria-hidden={copy > 0 || undefined}>
            {logos.map((l, i) => (
              <div
                key={i}
                className={`${s.logo} ${chips ? s.chip : ""}`}
                style={{ width: boxes[i].width + 2 * LOGO_PAD, height: LOGO_H + 2 * LOGO_PAD, marginRight: LOGO_GAP }}
              >
                <img
                  src={sizedImageSrc(l.logoUrl, Math.max(200, boxes[i].width * 2)) ?? l.logoUrl}
                  alt={copy === 0 ? l.name || "Sponsor" : ""}
                  width={boxes[i].width}
                  height={boxes[i].height}
                  loading="eager"
                  decoding="async"
                  style={{ width: boxes[i].width, height: boxes[i].height }}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
