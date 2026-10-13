import { HStack, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, monospacedDigit, padding } from "@expo/ui/swift-ui/modifiers";
import { createLiveActivity, type LiveActivityEnvironment } from "expo-widgets";

/**
 * Must match the server's content state (src/lib/notify/liveActivity.ts,
 * LiveScoreState): name "MatchScore". `phase`, `until`, `from` and `matchId`
 * came with Phase 6; a card pushed by an older server has none of them and reads
 * as live.
 */
export type MatchScoreProps = {
  a: string;
  b: string;
  sets: string;
  points: string;
  serving: "A" | "B" | null;
  status: string;
  court: string;
  matchId?: string;
  phase?: "soon" | "called" | "live" | "final";
  /** Countdown target, epoch ms (soon: the start time; called: the deadline to be at court). */
  until?: number | null;
  /** Countdown start, epoch ms. */
  from?: number | null;
};

/**
 * The card. This function runs inside the widget extension's own JavaScript
 * context (the "widget" directive ships its source there), so it may use only
 * its arguments, the @expo/ui components and modifiers, and JavaScript built-ins:
 * no imports, no helpers from outside it.
 */
const MatchScore = (p: MatchScoreProps, env: LiveActivityEnvironment) => {
  "widget";
  const yellow = env.isLuminanceReduced ? "#FFFFFF" : "#FCFC00";
  const ink = "#E8ECF4";
  const dim = env.isStale ? "#6B7385" : "#9AA4B8";
  const phase = p.phase || "live";
  const upcoming = phase === "soon" || phase === "called";
  const dotA = phase === "live" && p.serving === "A" ? "● " : "";
  const dotB = phase === "live" && p.serving === "B" ? " ●" : "";
  const now = Date.now();
  const until = typeof p.until === "number" ? p.until : 0;
  // A countdown only while its target is ahead (SwiftUI's timer range must not be empty);
  // afterwards the label says it is time.
  const counting = upcoming && until > now;
  const lower = new Date(Math.min(typeof p.from === "number" ? p.from : now, now));
  const upper = new Date(until);
  const timer = (size: number, color: string) =>
    counting ? (
      <Text timerInterval={{ lower, upper }} countsDown modifiers={[font({ weight: "black", size }), monospacedDigit(), foregroundStyle(color)]} />
    ) : (
      <Text modifiers={[font({ weight: "black", size }), foregroundStyle(color)]}>{phase === "called" ? "Now" : "Soon"}</Text>
    );
  const where = phase === "called" ? (p.court ? `Be on ${p.court}` : "Head to your court") : p.court ? `Next on ${p.court}` : "Up next";
  const line = `${p.status}${p.court ? ` · ${p.court}` : ""}`;
  const big = phase === "final" ? "Final" : p.points;

  return {
    banner: (
      <VStack modifiers={[padding({ all: 14 })]}>
        <HStack>
          <Text modifiers={[font({ weight: "heavy", size: 13 }), foregroundStyle(yellow)]}>MOVE SCORE</Text>
          <Spacer />
          <Text modifiers={[font({ size: 12 }), foregroundStyle(dim)]}>{upcoming ? p.status : line}</Text>
        </HStack>
        {upcoming ? (
          <HStack>
            <VStack>
              <Text modifiers={[font({ weight: "bold", size: 20 }), foregroundStyle(ink)]}>{`${p.a} v ${p.b}`}</Text>
              <Text modifiers={[font({ size: 14 }), foregroundStyle(dim)]}>{where}</Text>
            </VStack>
            <Spacer />
            {timer(30, yellow)}
          </HStack>
        ) : (
          <HStack>
            <Text modifiers={[font({ weight: "bold", size: 22 }), foregroundStyle(ink)]}>{`${dotA}${p.a}`}</Text>
            <Spacer />
            <Text modifiers={[font({ weight: "black", size: 26 }), foregroundStyle(yellow)]}>{big}</Text>
            <Spacer />
            <Text modifiers={[font({ weight: "bold", size: 22 }), foregroundStyle(ink)]}>{`${p.b}${dotB}`}</Text>
          </HStack>
        )}
        {upcoming ? null : <Text modifiers={[font({ size: 14 }), foregroundStyle(dim)]}>{p.sets}</Text>}
      </VStack>
    ),
    compactLeading: <Text modifiers={[font({ weight: "bold", size: 13 }), foregroundStyle(yellow)]}>{phase === "called" ? "COURT" : p.a}</Text>,
    compactTrailing: upcoming ? timer(13, ink) : <Text modifiers={[font({ weight: "bold", size: 13 }), foregroundStyle(ink)]}>{p.points || p.sets}</Text>,
    minimal: upcoming ? timer(11, yellow) : <Text modifiers={[font({ weight: "heavy", size: 12 }), foregroundStyle(yellow)]}>{p.points ? p.points.split("-")[0] : "●"}</Text>,
    expandedLeading: (
      <VStack modifiers={[padding({ all: 8 })]}>
        <Text modifiers={[font({ weight: "bold", size: 18 }), foregroundStyle(ink)]}>{`${dotA}${p.a}`}</Text>
      </VStack>
    ),
    expandedTrailing: (
      <VStack modifiers={[padding({ all: 8 })]}>
        <Text modifiers={[font({ weight: "bold", size: 18 }), foregroundStyle(ink)]}>{`${p.b}${dotB}`}</Text>
      </VStack>
    ),
    expandedCenter: upcoming ? timer(24, yellow) : <Text modifiers={[font({ weight: "black", size: 24 }), foregroundStyle(yellow)]}>{big}</Text>,
    expandedBottom: <Text modifiers={[font({ size: 13 }), foregroundStyle(dim)]}>{upcoming ? where : `${p.sets}${p.court ? ` · ${p.court}` : ""}`}</Text>,
  };
};

export default createLiveActivity<MatchScoreProps>("MatchScore", MatchScore);
