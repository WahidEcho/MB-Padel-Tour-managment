/**
 * Scoring screen v2 (Move Score app): the Fault · Ace · Let row, two tall point
 * columns side by side (left and right as the referee sees the court, swapping at
 * each change of ends), Undo · Pause · Serve · More, the timers with the referee's
 * ruling, the doubles set-start question and the match log. The rules are the
 * shared engine's (@core: serve.ts, timing.ts, console.ts); this file only draws.
 * Follows the app theme (light / dark) and Sunlight.
 */
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import {
  BALL,
  BALL_INK,
} from "../theme/palette";
import {
  TIMERS,
  clockText,
  currentServer,
  serveNumber,
  timerView,
  violationMarks,
  RULINGS,
  type LogEntry,
  type ScoreState,
  type ServeOrder,
  type ScoringFeatures,
  type TeamKey,
  type TimeDecision,
} from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display, Eyebrow, Num } from "../ui/Text";
import type { RunningTimer } from "./useConsole";
import { useT } from "../i18n";
import { fmt } from "../i18n/t";
import { chipText, decisionLabel, richParts, timerLabel } from "./scoreWords";

/** The point columns: the first-listed side red, the other blue (as on the venue screens). */
export const SIDE_HEX: Record<TeamKey, string> = { A: "#E5133A", B: "#1E5BFF" };
export const ORANGE = "#FF9F0A";

export interface V2Side {
  name: string;
  code: string;
  players: string[];
}

/** Re-renders four times a second while a timer runs. */
export function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function Square({ label, sub, onPress, disabled, active, testID }: { label: string; sub?: string | null; onPress: () => void; disabled?: boolean; active?: boolean; testID?: string }) {
  const { t } = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={sub ? `${label}, ${sub}` : label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        height: 70,
        borderRadius: 18,
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        backgroundColor: active ? "rgba(255,159,10,0.12)" : t.surface,
        borderWidth: 2,
        borderColor: active ? ORANGE : t.line,
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
      })}
    >
      <Body weight="bold" size={18} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{label}</Body>
      {sub ? (
        <View style={{ backgroundColor: active ? ORANGE : t.chip, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2 }}>
          <Eyebrow size={9.5} style={{ color: active ? "#000" : t.ink2, letterSpacing: 1 }}>{sub}</Eyebrow>
        </View>
      ) : null}
    </Pressable>
  );
}

/** Fault · Ace · Let, the two point columns, Undo · Pause · Serve · More. */
export function PadV2({
  state,
  sides,
  features,
  swapped,
  readOnly,
  paused,
  blocked,
  canUndo,
  onPoint,
  onFault,
  onAce,
  onLet,
  onUndo,
  onPause,
  onServe,
  onMore,
}: {
  state: ScoreState;
  sides: Record<TeamKey, V2Side>;
  features: ScoringFeatures;
  swapped: boolean;
  readOnly: boolean;
  paused: boolean;
  blocked: boolean;
  canUndo: boolean;
  onPoint: (k: TeamKey) => void;
  onFault: () => void;
  onAce: () => void;
  onLet: () => void;
  onUndo: () => void;
  onPause: () => void;
  onServe: () => void;
  onMore: () => void;
}) {
  const { t } = useTheme();
  const tr = useT();
  const server = currentServer(state);
  const second = serveNumber(state) === 2;
  const off = readOnly || paused || blocked;
  const order: TeamKey[] = swapped ? ["B", "A"] : ["A", "B"];
  const hasMarks = (state.violations?.length ?? 0) > 0;
  // A short pad (a call card open above it) with marks: smaller words so they still fit above the marks.
  const [padH, setPadH] = useState(0);
  const tight = hasMarks && padH > 0 && padH < 260;
  return (
    <View style={{ flex: 1, gap: 10 }}>
      {features.fault || features.ace || features.let ? (
        <View style={{ flexDirection: "row", gap: 10 }}>
          {features.fault ? <Square testID="v2-fault" label={tr("score.fault")} sub={second ? tr("score.secondServe") : tr("score.firstServe")} active={second} disabled={off || !server} onPress={onFault} /> : null}
          {features.ace ? <Square testID="v2-ace" label={tr("score.ace")} disabled={off || !server} onPress={onAce} /> : null}
          {features.let ? <Square testID="v2-let" label={tr("score.let")} disabled={off} onPress={onLet} /> : null}
        </View>
      ) : null}
      <View style={{ flex: 1, flexDirection: "row", gap: 10 }} onLayout={(e) => setPadH(e.nativeEvent.layout.height)}>
        {order.map((k) => {
          const s = sides[k];
          const marks = violationMarks(state, k);
          const serving = server === k && !state.matchOver;
          return (
            <Pressable
              key={k}
              testID={`v2-point-${k}`}
              accessibilityRole="button"
              accessibilityLabel={tr(serving ? "score.pointToServing" : "score.pointTo", { name: s.name })}
              disabled={off}
              onPress={() => onPoint(k)}
              style={({ pressed }) => ({
                flex: 1,
                borderRadius: 24,
                backgroundColor: SIDE_HEX[k],
                alignItems: "center",
                justifyContent: "center",
                gap: tight ? 4 : 8,
                paddingHorizontal: 8,
                // Room for the violation marks, on both buttons so the words stay level: a short
                // button (a call card open above) must not push the words under the marks.
                paddingBottom: hasMarks ? (tight ? 34 : 42) : 0,
                opacity: off ? 0.4 : 1,
                transform: [{ scale: pressed ? 0.975 : 1 }],
              })}
            >
              {/* In the flow (not floating), so it can never cover the words; kept on both sides
                  (hidden on the receiver's) so the two buttons stay aligned. */}
              <View
                style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: BALL, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, opacity: serving ? 1 : 0 }}
                importantForAccessibility={serving ? "auto" : "no-hide-descendants"}
                accessibilityElementsHidden={!serving}
              >
                <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: BALL_INK }} />
                <Eyebrow size={10.5} style={{ color: BALL_INK, letterSpacing: 1 }} numberOfLines={1}>{tr("score.serving")}</Eyebrow>
              </View>
              {/* "POINT" and the side's code, each on one line, shrinking to the button's width on any phone. */}
              <View style={{ alignSelf: "stretch" }}>
                {tr("score.pointCode", { code: s.code })
                  .split("\n")
                  .map((line, i) => (
                    <Display key={i} size={tight ? 30 : 38} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.45} style={{ color: "#fff", textAlign: "center", lineHeight: tight ? 32 : 40 }}>
                      {line}
                    </Display>
                  ))}
              </View>
              <Eyebrow size={11} style={{ color: "rgba(255,255,255,0.85)", textAlign: "center" }} numberOfLines={2}>
                {serving ? tr("score.nameServing", { name: s.name }) : s.name}
              </Eyebrow>
              <ViolationMarks marks={marks} />
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(
          [
            ["↶", tr("score.undo"), onUndo, !canUndo || readOnly || blocked, "v2-undo"],
            [paused ? "▶" : "❚❚", paused ? tr("score.resume") : tr("score.pause"), onPause, readOnly || blocked, "v2-pause"],
            ["⇄", tr("score.serve"), onServe, off, "v2-serve"],
            ["•••", tr("score.more"), onMore, false, "v2-more"],
          ] as [string, string, () => void, boolean, string][]
        ).map(([icon, label, fn, disabled, id]) => (
          <Pressable
            key={id}
            testID={id}
            onPress={fn}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => ({ flex: 1, alignItems: "center", gap: 3, paddingVertical: 12, borderRadius: 16, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, opacity: disabled ? 0.4 : pressed ? 0.7 : 1 })}
          >
            <Body size={17}>{icon}</Body>
            <Body weight="bold" size={12} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{label}</Body>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Rulings({ onDecision }: { onDecision: (d: TimeDecision) => void }) {
  useT();
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {RULINGS.map((d) => (
        <Pressable key={d} testID={`ruling-${d}`} accessibilityRole="button" onPress={() => onDecision(d)} style={({ pressed }) => ({ flex: 1, paddingVertical: 10, borderRadius: 12, backgroundColor: pressed ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.18)", alignItems: "center" })}>
          <Body weight="bold" size={12} style={{ color: "#fff" }}>{decisionLabel(d)}</Body>
        </Pressable>
      ))}
    </View>
  );
}

function Bar({ progress, color, track }: { progress: number; color: string; track: string }) {
  return (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: track, overflow: "hidden" }}>
      <View style={{ width: `${Math.round(Math.min(1, progress) * 100)}%`, height: 6, borderRadius: 3, backgroundColor: color }} />
    </View>
  );
}

/** The 25 s between points: a banner across the top of the scoreboard. */
export function BetweenPoints({ timer, now, onDismiss, onDecision }: { timer: RunningTimer; now: number; onDismiss: () => void; onDecision: (d: TimeDecision) => void }) {
  const { t } = useTheme();
  const tr = useT();
  const v = timerView(timer.kind, now - timer.startedAt);
  return (
    <View testID="timer-25" style={{ borderRadius: 20, borderWidth: 2, borderColor: v.over ? t.liveFill : t.blue, backgroundColor: v.over ? t.liveFill : t.surface, padding: 14, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <View>
          <Num size={30} style={{ color: v.over ? "#fff" : t.ink }}>{`${v.text} / ${clockText(v.limit ?? 25)}`}</Num>
          <Eyebrow size={10} style={{ color: v.over ? "#fff" : t.ink2 }}>{v.over ? tr("score.time") : tr("score.nextServe")}</Eyebrow>
        </View>
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          {!v.over ? (
            <Pressable testID="timer-dismiss" accessibilityRole="button" onPress={onDismiss} style={{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 12, backgroundColor: t.chip, borderWidth: 1, borderColor: t.line }}>
              <Body weight="bold" size={12}>{tr("score.dismiss")}</Body>
            </Pressable>
          ) : null}
        </View>
      </View>
      <Bar progress={v.progress ?? 0} color={v.over ? "#fff" : t.blue} track={v.over ? "rgba(255,255,255,0.3)" : t.chip} />
      {v.ruling ? <Rulings onDecision={onDecision} /> : null}
    </View>
  );
}

/**
 * Ⓣ (time) and Ⓒ (code) at the bottom left of a POINT button, one per violation, oldest
 * first, for the whole match.
 */
function ViolationMarks({ marks }: { marks: ("T" | "C")[] }) {
  const tr = useT();
  if (marks.length === 0) return null;
  const time = marks.filter((m) => m === "T").length;
  return (
    <View
      testID="violation-marks"
      pointerEvents="none"
      accessibilityLabel={tr("score.violationMarks", { time, code: marks.length - time })}
      style={{ position: "absolute", left: 10, bottom: 10, right: 10, flexDirection: "row", flexWrap: "wrap-reverse", gap: 5 }}
    >
      {marks.map((m, i) => (
        <View key={i} style={{ width: 26, height: 26, borderRadius: 13, borderWidth: 2.5, borderColor: "#fff", backgroundColor: "rgba(0,0,0,0.22)", alignItems: "center", justifyContent: "center" }}>
          <Body weight="bold" size={13} style={{ color: "#fff", lineHeight: 15 }}>{m}</Body>
        </View>
      ))}
    </View>
  );
}

/** A changeover, set break or break: a card over the point columns. */
/** `onRetire`: a medical timeout's second choice, "Player retires" (the end-of-match sheet). */
export function TimerCard({ timer, now, sides, onStop, onDecision, onRetire }: { timer: RunningTimer; now: number; sides: Record<TeamKey, V2Side>; onStop: () => void; onDecision: (d: TimeDecision) => void; onRetire?: () => void }) {
  const { t } = useTheme();
  const tr = useT();
  const v = timerView(timer.kind, now - timer.startedAt);
  const def = TIMERS[timer.kind];
  const label = timerLabel(timer.kind);
  const red = v.over && def.mode === "limit";
  const amber = v.over && def.mode === "warn";
  const title = timer.kind === "changeover" ? tr("score.changeOfEnds") : timer.team ? tr("score.timerTitleTeam", { label, name: sides[timer.team].name }) : label;
  const started = fmt().time(timer.startedAt);
  const note =
    def.mode === "open"
      ? tr("score.stopwatchStarted", { time: started })
      : def.mode === "warn"
        ? v.over
          ? tr("score.warnOver", { elapsed: v.text, limit: clockText(def.limit ?? 0) })
          : tr("score.warnRunning", { time: started, limit: clockText(def.limit ?? 0) })
        : v.over
          ? tr("score.limitOver", { seconds: v.overBy, limit: clockText(def.limit ?? 0), label: label.toLowerCase() })
          : tr("score.limitRunning", { label, limit: clockText(def.limit ?? 0) });
  const ink = red ? "#fff" : amber ? ORANGE : t.ink;
  return (
    <View testID="timer-card" style={{ borderRadius: 26, borderWidth: 2, borderColor: red ? t.liveFill : amber ? ORANGE : t.line, backgroundColor: red ? t.liveFill : t.surface, padding: 18, gap: 10, alignItems: "stretch" }}>
      <Eyebrow size={12} style={{ color: ink, textAlign: "center" }}>{red ? tr("score.timerTitleTime", { title }) : title}</Eyebrow>
      <View style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "center", gap: 6 }}>
        <Num size={72} style={{ color: ink, lineHeight: 76 }}>{v.text}</Num>
        {def.mode === "limit" && def.limit !== null ? <Num size={24} style={{ color: red ? "rgba(255,255,255,0.75)" : t.ink2, marginBottom: 10 }}>{`/ ${clockText(def.limit)}`}</Num> : null}
      </View>
      <Body size={12.5} weight="semi" style={{ color: red ? "#fff" : amber ? ORANGE : t.ink2, textAlign: "center" }}>{note}</Body>
      {v.progress !== null ? <Bar progress={v.progress} color={red ? "#fff" : amber ? ORANGE : t.blue} track={red ? "rgba(255,255,255,0.3)" : t.chip} /> : null}
      {timer.kind === "warmup" && v.over ? <Body size={12.5} style={{ color: "#fff", textAlign: "center" }}>{tr("score.warmupOver")}</Body> : null}
      {timer.kind === "medical" ? (
        <View style={{ gap: 10 }}>
          <Body size={12.5} style={{ color: red ? "#fff" : t.ink2, textAlign: "center" }}>{tr("score.medicalNote")}</Body>
          <Pressable testID="medical-continue" accessibilityRole="button" onPress={onStop} style={({ pressed }) => ({ backgroundColor: BALL, borderRadius: 18, paddingVertical: 15, alignItems: "center", opacity: pressed ? 0.85 : 1 })}>
            <Body weight="bold" size={16} style={{ color: BALL_INK }}>{tr("score.medicalContinue")}</Body>
          </Pressable>
          {onRetire ? (
            <Pressable testID="medical-retire" accessibilityRole="button" onPress={onRetire} style={({ pressed }) => ({ borderRadius: 18, paddingVertical: 14, alignItems: "center", borderWidth: 2, borderColor: red ? "#fff" : t.line, opacity: pressed ? 0.85 : 1 })}>
              <Body weight="bold" size={15} style={{ color: ink }}>{tr("score.medicalRetire")}</Body>
            </Pressable>
          ) : null}
        </View>
      ) : v.ruling ? (
        <Rulings onDecision={onDecision} />
      ) : (
        <Pressable testID="timer-stop" accessibilityRole="button" onPress={onStop} style={({ pressed }) => ({ backgroundColor: BALL, borderRadius: 18, paddingVertical: 15, alignItems: "center", opacity: pressed ? 0.85 : 1 })}>
          <Body weight="bold" size={16} style={{ color: BALL_INK }}>{timer.kind === "warmup" ? tr("score.warmupStart") : def.mode === "limit" ? tr("score.resumePlay") : tr("score.stop")}</Body>
        </Pressable>
      )}
    </View>
  );
}

type OrderStep = "team" | "server" | "receiver" | "next";
const ORDER_STEPS: OrderStep[] = ["team", "server", "receiver", "next"];

/**
 * Doubles, at the start of every set (ITF Rule 14), three questions with nothing picked in
 * advance: which country serves first, which of its players serves, which player of the other
 * country receives first. The country the console expects (the toss at the first set, then the
 * rotation) is shown as a hint, never chosen for the referee (`initial.servingTeam`, `firstSet`).
 * The other country's server keeps the set's default (`initial`): it chooses when its first
 * service game comes, and More → "Swap … server" corrects it; the scoreboard does not name a
 * receiver it was not told.
 */
export function ServeOrderForm({ sides, initial, onConfirm, firstSet = false }: { sides: Record<TeamKey, V2Side>; initial: ServeOrder; onConfirm: (o: ServeOrder) => void; firstSet?: boolean }) {
  const { t } = useTheme();
  const tr = useT();
  const [picks, setPicks] = useState<{ team?: TeamKey; server?: 0 | 1; receiver?: 0 | 1 }>({});
  const [i, setI] = useState(0);
  const step = ORDER_STEPS[i];
  const team: TeamKey = picks.team ?? initial.servingTeam;
  const other: TeamKey = team === "A" ? "B" : "A";
  const players = (k: TeamKey): [0 | 1, string][] => [
    [0, sides[k].players[0] ?? tr("score.player1")],
    [1, sides[k].players[1] ?? tr("score.player2")],
  ];
  const pick = (patch: { team?: TeamKey; server?: 0 | 1; receiver?: 0 | 1 }) => {
    // A different country makes the player answers of the old one meaningless.
    const next = patch.team && patch.team !== picks.team ? { team: patch.team } : { ...picks, ...patch };
    setPicks(next);
    setI(Math.min(i + 1, ORDER_STEPS.length - 1));
  };
  // The chosen team's own defaults for the rest: `initial` holds them by its serving team.
  const rest = team === initial.servingTeam ? { otherServer: initial.otherServer, otherReceiver: initial.otherReceiver } : { otherServer: initial.server, otherReceiver: initial.receiver };
  const order: ServeOrder | null =
    picks.team && picks.server !== undefined && picks.receiver !== undefined ? { servingTeam: picks.team, server: picks.server, receiver: picks.receiver, ...rest } : null;
  return (
    <View style={{ gap: 16 }} testID="serve-order">
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Eyebrow size={11} tone="ink3">{step === "next" ? tr("score.checkAndConfirm") : tr("score.questionOf", { n: i + 1, total: 3 })}</Eyebrow>
        {i > 0 ? (
          <Pressable accessibilityRole="button" onPress={() => setI(i - 1)} hitSlop={10}>
            <Body tone="blue" weight="semi" size={14}>{tr("score.backLink")}</Body>
          </Pressable>
        ) : null}
      </View>
      {step === "team" ? (
        <View style={{ gap: 10 }}>
          <BigChoice question={tr("score.whichCountry")} value={picks.team} options={[["A", sides.A.name], ["B", sides.B.name]] as [TeamKey, string][]} onPick={(v) => pick({ team: v })} />
          <View style={{ backgroundColor: t.chip, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 }}>
            <Body tone="ink2" size={13}>{tr(firstSet ? "score.tossHint" : "score.rotationHint", { name: sides[initial.servingTeam].name })}</Body>
          </View>
        </View>
      ) : null}
      {step === "server" ? <BigChoice question={tr("score.whichPlayerServes", { name: sides[team].name })} value={picks.server} options={players(team)} onPick={(v) => pick({ server: v })} /> : null}
      {step === "receiver" ? <BigChoice question={tr("score.whichPlayerReceives", { name: sides[other].name })} value={picks.receiver} options={players(other)} onPick={(v) => pick({ receiver: v })} /> : null}
      {step === "next" && order ? (
        <View style={{ gap: 16 }}>
          <Body size={16}>
            {richParts("score.servesTo", { server: sides[team].players[order.server] ?? tr("score.player"), team: sides[team].name, receiver: sides[other].players[order.receiver] ?? tr("score.player"), other: sides[other].name }, ["server", "receiver"]).map((part, n) =>
              part.bold ? (
                <Body key={n} weight="bold" size={16}>
                  {part.text}
                </Body>
              ) : (
                part.text
              ),
            )}
          </Body>
          <Pressable testID="serve-order-confirm" accessibilityRole="button" onPress={() => onConfirm(order)} style={({ pressed }) => ({ backgroundColor: BALL, borderRadius: 18, paddingVertical: 16, alignItems: "center", opacity: pressed ? 0.85 : 1 })}>
            <Body weight="bold" size={16} style={{ color: BALL_INK }}>{tr("score.startSet")}</Body>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function BigChoice<V extends string | number>({ question, value, options, onPick }: { question: string; value: V | undefined; options: [V, string][]; onPick: (v: V) => void }) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 12 }}>
      <Body weight="bold" size={19}>{question}</Body>
      {options.map(([v, text]) => {
        const on = v === value;
        return (
          <Pressable
            key={String(v)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => onPick(v)}
            style={({ pressed }) => ({ minHeight: 64, justifyContent: "center", paddingHorizontal: 18, borderRadius: 18, borderWidth: 2, borderColor: on ? t.blue : t.line, backgroundColor: on ? "rgba(77,155,255,0.14)" : t.chip, opacity: pressed ? 0.8 : 1 })}
          >
            <Body weight="bold" size={17} numberOfLines={1}>{text}</Body>
          </Pressable>
        );
      })}
    </View>
  );
}

const CHIP_COLOR: Record<string, [string, string]> = {
  ace: [BALL, BALL_INK],
  double_fault: ["#E5133A", "#fff"],
  fault: [ORANGE, "#000"],
  let: ["#1E5BFF", "#fff"],
  violation: [ORANGE, "#000"],
  time_ruling: [ORANGE, "#000"],
};

/** The match log, newest first, a heading per set. */
export function MatchLogList({ entries }: { entries: LogEntry[] }) {
  const { t } = useTheme();
  const tr = useT();
  const list = [...entries].reverse();
  if (!list.length) return <Body tone="ink2">{tr("score.logEmpty")}</Body>;
  return (
    <View testID="match-log">
      {list.map((e, i) => {
        const head = e.set !== null && (i === 0 || list[i - 1].set !== e.set);
        const chip = e.chip ? (CHIP_COLOR[e.tag] ?? [t.chip, t.ink2]) : null;
        return (
          <View key={e.n}>
            {head ? <Eyebrow size={11} tone="ink3" style={{ paddingTop: 12, paddingBottom: 4 }}>{tr("score.setN", { n: e.set })}</Eyebrow> : null}
            <View style={{ flexDirection: "row", gap: 10, paddingVertical: 10, borderTopWidth: head ? 0 : 1, borderColor: t.line, opacity: e.undone || e.superseded ? 0.5 : 1 }}>
              <Num size={13} tone="ink3" style={{ width: 44 }}>{e.at ? fmt().time(e.at) : ""}</Num>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Body weight="bold" size={14} style={e.undone ? { textDecorationLine: "line-through" } : undefined}>{e.title}</Body>
                <Body tone="ink2" size={12.5}>{`${e.detail}${e.by ? ` · ${e.by}` : ""}${e.undone ? ` · ${tr("score.undone")}` : ""}`}</Body>
              </View>
              {chip ? (
                <View style={{ alignSelf: "center", backgroundColor: chip[0], borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 }}>
                  <Eyebrow size={9.5} style={{ color: chip[1], letterSpacing: 0.8 }}>{chipText(e.chip!)}</Eyebrow>
                </View>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
