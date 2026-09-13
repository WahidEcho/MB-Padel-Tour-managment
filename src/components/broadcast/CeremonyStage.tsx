"use client";

import { useState } from "react";
import {
  CEREMONY,
  ceremonySteps,
  podiumCount,
  placeLabel,
  revealedPlaces,
  stepAt,
  type CeremonyPlace,
  type CeremonyStep,
  type CeremonyTier,
} from "@/lib/tv/ceremony";
import { seekStyle } from "@/lib/tv/timeline";
import { useLive } from "./LiveFeedProvider";
import PersonPortrait from "./PersonPortrait";

/** Podium order left to right: runner-up, champion, third, fourth — the champion stands in the middle. */
const PODIUM_ORDER = [2, 1, 3, 4];
/** Each step stands taller, so the frame reads as a podium from across a hall. */
const HEIGHT: Record<number, number> = { 1: 800, 2: 680, 3: 600, 4: 540 };

/**
 * The closing ceremony on the wall.
 *
 * The operator's NEXT PLACE writes a step and a server timestamp; this seeks the
 * step's build from that stamp. A reload, a second wall or a slow poll lands on
 * the same frame, and REPLAY — a new stamp on the same step — plays it again.
 * With `finale` it shows the finished podium with nothing moving, which is what
 * the older "winner" mode and the control-room thumbnails want.
 */
export default function CeremonyStage({ tiers, finale = false }: { tiers: CeremonyTier[]; finale?: boolean }) {
  const { feed, now, motion, anchored } = useLive();
  const steps = ceremonySteps(tiers);
  if (steps.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-center text-[48px] text-muted" data-testid="ceremony-empty">
        The podium appears here once the finals are decided.
      </div>
    );
  }

  const stored = finale ? steps.length - 1 : (feed?.screen.ceremony_step ?? 0);
  const { step, index } = stepAt(steps, stored);
  const stamp = finale ? null : (feed?.screen.ceremony_step_at ?? null);
  const stampMs = stamp ? Date.parse(stamp) : NaN;
  const elapsed = Number.isFinite(stampMs) ? Math.max(0, now - stampMs) : Number.POSITIVE_INFINITY;
  // The build is seeked once, at mount. Until the first poll corrects the clock
  // against the server, that seek would come from a venue PC's own clock, so a
  // reload shows the settled frame first and seeks for real once anchored.
  const animate = motion && !finale && anchored;

  return (
    <StepView
      // A new step, or the same step re-stamped by REPLAY, is a new timeline: it
      // mounts afresh and seeks from its own stamp. Polls within it change nothing.
      // Becoming able to animate (the clock anchoring, an unmute) re-seeks too.
      key={`${index}-${stamp ?? "finale"}-${animate ? "run" : "still"}`}
      tiers={tiers}
      step={step!}
      index={index}
      total={steps.length}
      elapsedMs={elapsed}
      animate={animate}
    />
  );
}

function StepView({
  tiers,
  step,
  index,
  total,
  elapsedMs,
  animate,
}: {
  tiers: CeremonyTier[];
  step: CeremonyStep;
  index: number;
  total: number;
  elapsedMs: number;
  animate: boolean;
}) {
  // Frozen at mount: re-deriving the delay on every tick would re-time a running
  // animation and play it at double speed.
  const [seekFrom] = useState(elapsedMs);
  // Seeked, so a wall that learns of the step a poll late still plays the rest of
  // it; only a wall joining well after the build shows the settled frame.
  const run = animate && seekFrom < CEREMONY.skipAfterMs;
  const seek = (begins = 0) => (run ? seekStyle(seekFrom, begins) : undefined);
  const tier = tiers[step.tierIndex];

  if (step.kind === "slate") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 text-center" data-testid="ceremony-slate" data-step={index}>
        <p
          className="bc-animate text-[40px] font-bold uppercase tracking-[0.35em] text-muted"
          style={run ? { animation: `bc-slate-in ${CEREMONY.riseMs}ms ease-out both`, ...seek(0) } : undefined}
        >
          Closing ceremony
        </p>
        <p
          className="bc-animate max-w-[1600px] text-[150px] font-black leading-none"
          style={run ? { animation: `bc-slate-in ${CEREMONY.riseMs}ms ease-out both`, ...seek(250) } : undefined}
        >
          {tier.label}
        </p>
        <p className="text-[32px] text-muted">
          {/* Counted in people on the podium, not places: tied players share one. */}
          {podiumCount(tier) === 1 ? "The champion" : `The top ${podiumCount(tier)}`} · {index + 1} of {total}
        </p>
      </div>
    );
  }

  const revealed = revealedPlaces(tiers, step);
  const slots = PODIUM_ORDER.filter((place) => tier.places.some((p) => p.place === place));
  const slotWidth = Math.min(440, Math.floor((1760 - 24 * (slots.length - 1)) / Math.max(1, slots.length)));
  const champion = step.place === 1;

  return (
    <div className="relative flex h-full flex-col" data-testid="ceremony-podium" data-step={index} data-place={step.place}>
      {champion && (
        <>
          {/* The winner's colour floods the frame, then settles. */}
          <div
            aria-hidden
            className="bc-animate pointer-events-none absolute inset-0"
            style={{
              background: "radial-gradient(60% 70% at 50% 60%, color-mix(in oklab, var(--accent) 40%, transparent), transparent 70%)",
              ...(run ? { animation: `bc-flood ${CEREMONY.floodMs}ms ease-out both`, ...seek(400) } : { opacity: 0.6 }),
            }}
          />
          {run && <Confetti seek={seek} />}
        </>
      )}

      <p className="relative z-10 pt-2 text-center text-[34px] font-bold uppercase tracking-[0.3em] text-muted">
        {tier.label} · {placeLabel(step.place)}
      </p>

      <div className="relative z-10 flex flex-1 items-end justify-center gap-6 px-20 pb-4">
        {slots.map((place) => {
          const shown = revealed.find((p) => p.place === place);
          const isNew = place === step.place;
          return (
            <div key={place} className="flex flex-col justify-end" style={{ width: slotWidth, height: HEIGHT[place] }}>
              {shown ? (
                <PlaceCard
                  place={shown}
                  style={isNew && run ? { animation: `bc-rise ${CEREMONY.riseMs}ms cubic-bezier(.2,.8,.2,1) both`, ...seek(0) } : undefined}
                />
              ) : (
                // Reserved, so revealing a place never shifts the ones already standing.
                <div className="h-full rounded-[28px] border-4 border-dashed border-border/60" aria-hidden />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlaceCard({ place, style }: { place: CeremonyPlace; style?: React.CSSProperties }) {
  const tied = place.entrants.length > 1;
  return (
    <div
      className={`bc-card bc-animate flex h-full flex-col items-center justify-center gap-4 px-5 py-6 text-center ${
        place.place === 1 ? "border-accent" : ""
      }`}
      style={style}
      data-testid={`ceremony-place-${place.place}`}
    >
      <p className={`font-black uppercase tracking-widest ${place.place === 1 ? "text-[48px] text-accent" : "text-[34px] text-muted"}`}>
        {placeLabel(place.place)}
      </p>
      {tied ? (
        <div className="flex w-full flex-col gap-3">
          {place.entrants.slice(0, 4).map((e) => (
            <div key={e.title} className="flex items-center gap-3">
              {e.people[0] && <PersonPortrait person={e.people[0]} size={96} rounded="rounded-2xl" />}
              <p className="min-w-0 truncate text-left text-[34px] font-bold">{e.title}</p>
            </div>
          ))}
          {place.entrants.length > 4 && <p className="text-[26px] text-muted">and {place.entrants.length - 4} more</p>}
        </div>
      ) : (
        place.entrants.map((e) => (
          <div key={e.title} className="flex flex-col items-center gap-4">
            <div className="flex -space-x-4">
              {e.people.slice(0, 2).map((p) => (
                <PersonPortrait key={p.id} person={p} size={place.place === 1 ? 190 : 150} />
              ))}
            </div>
            <p className={`font-black leading-tight ${place.place === 1 ? "text-[56px]" : "text-[42px]"}`}>{e.title}</p>
            {e.people.length > 1 && (
              <p className="text-[26px] text-muted">{e.people.map((p) => p.name).join(" & ")}</p>
            )}
          </div>
        ))
      )}
    </div>
  );
}

/** A burst of confetti for the champion, placed deterministically so server and client agree. */
function Confetti({ seek }: { seek: (begins?: number) => { animationDelay: string } | undefined }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" style={{ zIndex: 20 }}>
      {Array.from({ length: 32 }, (_, i) => {
        const left = (i * 37 + 11) % 100;
        const size = 14 + ((i * 7) % 12);
        const colour = ["var(--accent)", "#ffffff", "var(--warning)", "var(--success)"][i % 4];
        return (
          <span
            key={i}
            className="bc-animate absolute top-0 block rounded-sm"
            style={{
              left: `${left}%`,
              width: size,
              height: size * 0.5,
              background: colour,
              animation: `bc-confetti ${2200 + ((i * 53) % 900)}ms cubic-bezier(.3,.6,.4,1) both`,
              ...seek(500 + ((i * 61) % 700)),
            }}
          />
        );
      })}
    </div>
  );
}
