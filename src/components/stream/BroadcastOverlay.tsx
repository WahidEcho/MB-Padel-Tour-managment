"use client";

/* eslint-disable @next/next/no-img-element -- local SVG flags and CDN-sized logos, drawn as they are */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Big_Shoulders } from "next/font/google";
import { useAnchoredNow, useLiveFeed } from "@/components/broadcast/hooks";
import { flagSrc } from "@/components/tennis/Face";
import { logoBox } from "@/lib/sponsors";
import { sizedImageSrc } from "@/lib/portrait";
import type { LiveFeed } from "@/lib/tv/liveFeed";
import { overlayModel, type OverlayModel, type OverlayOptions, type OverlayRow } from "@/lib/stream/overlay";
import type { OverlayLogo, OverlayProps } from "@/lib/stream/overlayServer";
import s from "./overlay.module.css";

const display = Big_Shoulders({ subsets: ["latin", "latin-ext"], variable: "--ov-display", display: "block", weight: ["600", "700", "800"] });

/** The ACE tab stays out this long after the ace lands (or until the next point). */
const ACE_MS = 6_000;
/** The footer loop's speed: one stage pixel per frame at 60 fps. */
const TICKER_PX_PER_S = 60;
const LOGO_H = 52;
const LOGO_PAD = 10;
const LOGO_GAP = 64;

const STAGE = { w: 1920, h: 1080 };
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

  return (
    <div ref={frame} className={s.frame} data-testid="broadcast-overlay" data-court={props.court.name} data-state={model.kind}>
      <div className={`${s.stage} ${display.variable}`} style={{ transform: `scale(${fit})` }}>
        {options.bug && (model.kind !== "idle" || options.idle) && (
          <div className={s.bugWrap} style={{ transform: `scale(${options.scale})` }}>
            <Bug model={model} now={now} />
          </div>
        )}
        {options.footer && props.sponsors.length > 0 && (
          <div className={s.footer} style={{ transform: `scale(${options.scale})` }} data-testid="overlay-sponsors">
            <Ticker logos={props.sponsors} chips={props.chips} uniform={props.uniform} />
          </div>
        )}
      </div>
    </div>
  );
}

function Strip({ parts, live, only = false }: { parts: string[]; live: boolean; only?: boolean }) {
  return (
    <div className={`${s.strip} ${only ? s.stripOnly : ""}`} data-testid="overlay-header">
      {live && <span className={s.liveDot} />}
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <i>· </i>}
          {p}
        </span>
      ))}
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

function Bug({ model, now }: { model: OverlayModel; now: number }) {
  const ace = useAceFlash(model, now);
  if (model.kind === "idle") {
    return (
      <div className={s.bug} key="idle">
        <Strip parts={model.header} live={false} only />
      </div>
    );
  }
  const scored = model.kind === "live" || model.kind === "final";
  const setCount = scored ? Math.max(model.rows[0].sets.length, model.rows[1].sets.length) : 0;
  const hasGames = scored && model.rows.some((r) => r.games !== null);
  const cols = ["26px", "52px", "84px", "minmax(300px, max-content)", ...Array.from({ length: setCount }, () => "56px"), ...(hasGames ? ["60px"] : []), scored ? "84px" : "110px"];

  const cells = (row: OverlayRow, side: 0 | 1) => {
    const rb = side === 1 ? ` ${s.rowB}` : "";
    const out: React.ReactNode[] = [];
    out.push(
      <div key={`sv${side}`} className={`${s.cell} ${s.serve}${rb}`}>
        {row.serving && <span className={s.ball} data-testid="overlay-serving" />}
      </div>,
    );
    const flag = flagSrc(row.iso2);
    out.push(<div key={`fl${side}`} className={`${s.cell} ${s.flag}${rb}`}>{flag && <img src={flag} alt="" />}</div>);
    out.push(<div key={`cd${side}`} className={`${s.cell} ${s.code}${rb}`}>{row.code}</div>);
    out.push(
      <div key={`nm${side}`} className={`${s.cell} ${s.names}${rb}`} data-testid="overlay-names">
        {row.names.map((n, i) => (
          <span key={i} className={row.servingIndex !== null && row.servingIndex !== i ? s.other : undefined}>
            {i > 0 ? "/ " : ""}
            {n}
          </span>
        ))}
        {row.winner && <span className={s.winnerMark}>✓</span>}
      </div>,
    );
    if (!scored) {
      out.push(<div key={`lb${side}`} className={`${s.cell} ${s.labelCell}${rb}`}>{side === 0 ? "Next" : "on court"}</div>);
      return out;
    }
    for (let i = 0; i < setCount; i++) {
      const x = row.sets[i];
      out.push(
        <div key={`st${side}${i}`} className={`${s.cell} ${s.set} ${s.num} ${x?.won ? s.setWon : ""}${rb}`} data-testid="overlay-set">
          <span key={x?.games ?? "-"} className={s.pop}>{x?.games ?? ""}</span>
          {x?.tb !== null && x?.tb !== undefined && <sup>{x.tb}</sup>}
        </div>,
      );
    }
    if (hasGames) {
      out.push(
        <div key={`gm${side}`} className={`${s.cell} ${s.games} ${s.num}${rb}`} data-testid="overlay-games">
          <span key={row.games ?? "-"} className={s.pop}>{row.games ?? ""}</span>
        </div>,
      );
    }
    const final = model.kind === "final";
    out.push(
      <div key={`pt${side}`} className={`${s.cell} ${s.points} ${s.num} ${final ? s.pointsFinal : ""} ${side === 1 ? s.pointsRowB : ""}`} data-testid="overlay-points">
        {final ? (side === 0 ? "FINAL" : "") : <span key={`${row.points}:${model.eventNumber}`} className={s.flip}>{row.points}</span>}
      </div>,
    );
    return out;
  };

  const tab =
    model.kind === "live"
      ? model.clock
        ? (
            <div key="clock" className={`${s.tab} ${s.tabClock} ${model.clock.over ? s.tabOver : ""} ${s.num}`} data-testid="overlay-clock">
              <small>{model.clock.label}</small>
              {model.clock.text}
            </div>
          )
        : ace
          ? <div key={`ace${model.eventNumber}`} className={`${s.tab} ${s.tabAce}`} data-testid="overlay-ace">Ace</div>
          : model.paused
            ? <div key="paused" className={`${s.tab} ${s.tabPaused}`}>Play suspended</div>
            : model.callout
              ? <div key={`call${model.callout}${model.eventNumber}`} className={`${s.tab} ${s.tabCall}`} data-testid="overlay-callout">{model.callout}</div>
              : null
      : null;

  return (
    <div className={s.bug} key={`${model.kind}:${model.matchId}`} data-testid="overlay-bug" data-match={model.matchId}>
      <Strip parts={model.header} live={model.kind === "live"} />
      <div style={{ position: "relative" }}>
        <div className={s.grid} style={{ gridTemplateColumns: cols.join(" ") }}>
          {cells(model.rows[0], 0)}
          {cells(model.rows[1], 1)}
        </div>
        {tab}
      </div>
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
