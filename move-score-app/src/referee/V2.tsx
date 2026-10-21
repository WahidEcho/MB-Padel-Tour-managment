/**
 * Scoring screen v2 (Move Score app): the Fault · Ace · Let row, two tall point
 * columns side by side (left and right as the referee sees the court, swapping at
 * each change of ends), Undo · Pause · Serve · More, the timers with the referee's
 * ruling, the doubles set-start question and the match log. The rules are the
 * shared engine's (@core: serve.ts, timing.ts, console.ts); this file only draws.
 * Follows the app theme (light / dark) and Sunlight.
 */
import { useEffect, useState } from "react";
import { Linking, Pressable, View } from "react-native";
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
  type LogEntry,
  type ScoreState,
  type ServeOrder,
  type ScoringFeatures,
  type TeamKey,
  type TimeDecision,
} from "@core";
import { config } from "../config";
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
  return (
    <View style={{ flex: 1, gap: 10 }}>
      {features.fault || features.ace || features.let ? (
        <View style={{ flexDirection: "row", gap: 10 }}>
          {features.fault ? <Square testID="v2-fault" label={tr("score.fault")} sub={second ? tr("score.secondServe") : tr("score.firstServe")} active={second} disabled={off || !server} onPress={onFault} /> : null}
          {features.ace ? <Square testID="v2-ace" label={tr("score.ace")} disabled={off || !server} onPress={onAce} /> : null}
          {features.let ? <Square testID="v2-let" label={tr("score.let")} disabled={off} onPress={onLet} /> : null}
        </View>
      ) : null}
      <View style={{ flex: 1, flexDirection: "row", gap: 10 }}>
        {order.map((k) => {
          const s = sides[k];
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
                gap: 8,
                paddingHorizontal: 8,
                opacity: off ? 0.4 : 1,
                transform: [{ scale: pressed ? 0.975 : 1 }],
              })}
            >
              {serving ? (
                <View style={{ position: "absolute", top: 12, left: 12, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: BALL, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: BALL_INK }} />
                  <Eyebrow size={10.5} style={{ color: BALL_INK, letterSpacing: 1 }}>{tr("score.serving")}</Eyebrow>
                </View>
              ) : null}
              <Display size={38} style={{ color: "#fff", textAlign: "center", lineHeight: 38 }}>{tr("score.pointCode", { code: s.code })}</Display>
              <Eyebrow size={11} style={{ color: "rgba(255,255,255,0.85)", textAlign: "center" }} numberOfLines={2}>
                {serving ? tr("score.nameServing", { name: s.name }) : s.name}
              </Eyebrow>
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

function RuleRef({ kind, light }: { kind: RunningTimer["kind"]; light?: boolean }) {
  const { t } = useTheme();
  const tr = useT();
  const rule = TIMERS[kind].rule;
  if (!rule) return null;
  return (
    <Body
      size={11}
      weight="semi"
      accessibilityRole="link"
      onPress={() => void Linking.openURL(`${config.apiBaseUrl}${rule.href}`)}
      style={{ color: light ? "rgba(255,255,255,0.85)" : t.ink2, textDecorationLine: "underline", textAlign: "center" }}
    >
      {/29a/.test(rule.href) ? tr("score.rule29a") : rule.label}
    </Body>
  );
}

function Rulings({ onDecision }: { onDecision: (d: TimeDecision) => void }) {
  useT();
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {(["warning", "code_violation", "no_action"] as TimeDecision[]).map((d) => (
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
          <RuleRef kind={timer.kind} light={v.over} />
        </View>
      </View>
      <Bar progress={v.progress ?? 0} color={v.over ? "#fff" : t.blue} track={v.over ? "rgba(255,255,255,0.3)" : t.chip} />
      {v.ruling ? <Rulings onDecision={onDecision} /> : null}
    </View>
  );
}

/** A changeover, set break or break: a card over the point columns. */
export function TimerCard({ timer, now, sides, onStop, onDecision }: { timer: RunningTimer; now: number; sides: Record<TeamKey, V2Side>; onStop: () => void; onDecision: (d: TimeDecision) => void }) {
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
      {v.ruling ? (
        <Rulings onDecision={onDecision} />
      ) : (
        <Pressable testID="timer-stop" accessibilityRole="button" onPress={onStop} style={({ pressed }) => ({ backgroundColor: BALL, borderRadius: 18, paddingVertical: 15, alignItems: "center", opacity: pressed ? 0.85 : 1 })}>
          <Body weight="bold" size={16} style={{ color: BALL_INK }}>{def.mode === "limit" ? tr("score.resumePlay") : tr("score.stop")}</Body>
        </Pressable>
      )}
      <RuleRef kind={timer.kind} light={red} />
    </View>
  );
}

function ChoiceRow<V extends string | number>({ label, value, options, onPick }: { label: string; value: V; options: [V, string][]; onPick: (v: V) => void }) {
  const { t } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Body tone="ink2" weight="semi" size={13.5}>{label}</Body>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {options.map(([v, text]) => {
          const on = v === value;
          return (
            <Pressable
              key={String(v)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => onPick(v)}
              style={{ flex: 1, paddingVertical: 14, paddingHorizontal: 8, borderRadius: 16, borderWidth: 2, borderColor: on ? t.blue : t.line, backgroundColor: on ? "rgba(77,155,255,0.14)" : t.chip, alignItems: "center" }}
            >
              <Body weight="bold" size={15} numberOfLines={1}>{text}</Body>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * Doubles, at the start of every set: the serve and receive order (ITF Rule 14),
 * asked one question at a time:
 *   1. which country serves (first set only: the toss; later sets follow the rotation),
 *   2. which of its players serves,
 *   3. which player of the other side receives first,
 * then the second game's order on one screen, already filled in, to confirm.
 * Tapping an answer moves to the next question; Back goes one step back.
 */
type OrderStep = "team" | "server" | "receiver" | "next";

export function ServeOrderForm({ sides, initial, onConfirm, teamFree = true }: { sides: Record<TeamKey, V2Side>; initial: ServeOrder; onConfirm: (o: ServeOrder) => void; teamFree?: boolean }) {
  const { t } = useTheme();
  const tr = useT();
  const steps: OrderStep[] = teamFree ? ["team", "server", "receiver", "next"] : ["server", "receiver", "next"];
  const [o, setO] = useState<ServeOrder>(initial);
  const [i, setI] = useState(0);
  const step = steps[i];
  const team = o.servingTeam;
  const other: TeamKey = team === "A" ? "B" : "A";
  const players = (k: TeamKey): [0 | 1, string][] => [
    [0, sides[k].players[0] ?? tr("score.player1")],
    [1, sides[k].players[1] ?? tr("score.player2")],
  ];
  const pick = (patch: Partial<ServeOrder>) => {
    setO({ ...o, ...patch });
    setI(Math.min(i + 1, steps.length - 1));
  };
  const questions = steps.length - 1;
  return (
    <View style={{ gap: 16 }} testID="serve-order">
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Eyebrow size={11} tone="ink3">{step === "next" ? tr("score.checkAndConfirm") : tr("score.questionOf", { n: i + 1, total: questions })}</Eyebrow>
        {i > 0 ? (
          <Pressable accessibilityRole="button" onPress={() => setI(i - 1)} hitSlop={10}>
            <Body tone="blue" weight="semi" size={14}>{tr("score.backLink")}</Body>
          </Pressable>
        ) : null}
      </View>
      {!teamFree && step === "server" ? (
        <View style={{ backgroundColor: t.chip, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 }}>
          <Body weight="semi" size={14}>{tr("score.rotationServes", { name: sides[team].name })}</Body>
        </View>
      ) : null}
      {step === "team" ? (
        <BigChoice question={tr("score.whichCountry")} value={team} options={[["A", sides.A.name], ["B", sides.B.name]] as [TeamKey, string][]} onPick={(v) => pick({ servingTeam: v })} />
      ) : null}
      {step === "server" ? (
        <BigChoice question={tr("score.whichPlayerServes", { name: sides[team].name })} value={o.server} options={players(team)} onPick={(v) => pick({ server: v })} />
      ) : null}
      {step === "receiver" ? (
        <BigChoice question={tr("score.whichPlayerReceives", { name: sides[other].name })} value={o.receiver} options={players(other)} onPick={(v) => pick({ receiver: v })} />
      ) : null}
      {step === "next" ? (
        <View style={{ gap: 16 }}>
          <View style={{ gap: 6 }}>
            <Body size={14}>
              {richParts(
                "score.servesTo",
                { server: sides[team].players[o.server] ?? tr("score.player"), team: sides[team].name, receiver: sides[other].players[o.receiver] ?? tr("score.player"), other: sides[other].name },
                ["server", "receiver"],
              ).map((part, n) =>
                part.bold ? (
                  <Body key={n} weight="bold" size={14}>
                    {part.text}
                  </Body>
                ) : (
                  part.text
                ),
              )}
            </Body>
            <Body tone="ink2" size={13}>{tr("score.game2Note")}</Body>
          </View>
          <ChoiceRow label={tr("score.servesGame2", { name: sides[other].name })} value={o.otherServer} options={players(other)} onPick={(v) => setO({ ...o, otherServer: v })} />
          <ChoiceRow label={tr("score.receivesGame2", { name: sides[team].name })} value={o.otherReceiver} options={players(team)} onPick={(v) => setO({ ...o, otherReceiver: v })} />
          <Pressable testID="serve-order-confirm" accessibilityRole="button" onPress={() => onConfirm(o)} style={({ pressed }) => ({ backgroundColor: BALL, borderRadius: 18, paddingVertical: 16, alignItems: "center", opacity: pressed ? 0.85 : 1 })}>
            <Body weight="bold" size={16} style={{ color: BALL_INK }}>{tr("score.startSet")}</Body>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** One question with big answers stacked full width; tapping one answers it. */
function BigChoice<V extends string | number>({ question, value, options, onPick }: { question: string; value: V; options: [V, string][]; onPick: (v: V) => void }) {
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
