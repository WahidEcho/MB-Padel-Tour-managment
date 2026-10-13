/**
 * Final-result entry on the referee's phone (plan Phase 5), the app's twin of the
 * web console's FinalScoreEntry. Three steps, so a typo never reaches the
 * standings:
 *
 *   1. enter     both sides' scores side by side, set by set, checked against the
 *                match's own rules as they are typed (validateFinalScore); a 7-6
 *                set asks for the tie-break points of the side that lost it; a
 *                match tie-break is its points (10-8)
 *   2. summary   the result read back with the winner highlighted:
 *                "Keep editing" or "Confirm"
 *   3. confirm   a second confirmation before it is recorded
 *
 * Chess: win / draw / loss per game. A level knockout pairing asks who advances
 * only when the person is the organiser (admin or manager); a referee records it
 * level and the organiser decides.
 *
 * The parent queues or sends the payload and shows a refusal through `error`.
 */
import { useMemo, useState } from "react";
import { TextInput, View } from "react-native";
import {
  buildResultState,
  chessOutcome,
  chessScoreLine,
  finalScoreSummary,
  validateFinalScore,
  type ChessCompetition,
  type ChessGameResult,
  type MatchRules,
  type ResultPayload,
  type ResultProblem,
  type ScoreState,
  type TeamKey,
} from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display, Eyebrow, Num } from "../ui/Text";
import { Button } from "../ui/Bits";
import { digits, rowsFrom, setsFrom, visibleRows, type Row } from "./finalScoreForm";

export interface FinalScoreProps {
  engine: "games" | "chess";
  rules: MatchRules;
  legs?: 1 | 2;
  competition?: ChessCompetition;
  sideA: string;
  sideB: string;
  /** What the form starts from (a correction, or a result the server refused). */
  initial?: ResultPayload | null;
  /** The match already has a score: the result replaces it (logged). */
  correcting?: boolean;
  /** Admin or manager: may pick who advances from a level chess knockout. */
  canDecideAdvance?: boolean;
  busy?: boolean;
  error?: string | null;
  problems?: ResultProblem[] | null;
  /** Under the record button: what happens to the result (queued offline, needs a connection…). */
  note?: string | null;
  onSubmit: (payload: ResultPayload) => void;
  onCancel?: () => void;
}

type Step = "enter" | "summary" | "confirm";

function ScoreField({ value, onChange, label, wide }: { value: string; onChange: (v: string) => void; label: string; wide?: boolean }) {
  const { t } = useTheme();
  return (
    <TextInput
      value={value}
      onChangeText={(v) => onChange(digits(v))}
      keyboardType="number-pad"
      inputMode="numeric"
      maxLength={2}
      accessibilityLabel={label}
      selectTextOnFocus
      placeholder="–"
      placeholderTextColor={t.ink3}
      style={{
        width: wide ? 76 : 64,
        height: 56,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: t.line,
        backgroundColor: t.chip,
        color: t.ink,
        fontSize: 26,
        fontWeight: "700",
        textAlign: "center",
        fontVariant: ["tabular-nums"],
      }}
    />
  );
}

function Choice({ label, on, onPress, a11y }: { label: string; on: boolean; onPress: () => void; a11y: string }) {
  return <Button kind={on ? "primary" : "ghost"} label={label} onPress={onPress} accessibilityLabel={a11y} selected={on} style={{ flex: 1, paddingHorizontal: 8 }} />;
}

export function FinalScore(props: FinalScoreProps) {
  const { engine, rules, sideA, sideB, correcting, canDecideAdvance, busy, error, problems: serverProblems, note, onSubmit, onCancel } = props;
  const { t } = useTheme();
  const legs = props.legs ?? 1;
  const competition = props.competition ?? "knockout";
  const maxSets = Math.max(1, 2 * rules.setsToWinMatch - 1);
  const [step, setStep] = useState<Step>("enter");
  const [rows, setRows] = useState<Row[]>(() => rowsFrom(rules, props.initial && "sets" in props.initial ? props.initial.sets : undefined, maxSets));
  const [games, setGames] = useState<(ChessGameResult | null)[]>(() => {
    const init = props.initial && "chess" in props.initial ? props.initial.chess : [];
    return Array.from({ length: legs }, (_, i) => init[i] ?? null);
  });
  const [advance, setAdvance] = useState<TeamKey | null>(null);

  const sets = useMemo(() => setsFrom(rules, rows), [rules, rows]);
  const shown = useMemo(() => visibleRows(rules, rows), [rules, rows]);
  const liveProblems = useMemo(() => (engine === "games" ? validateFinalScore(rules, sets) : []), [engine, rules, sets]);

  const payload: ResultPayload | null = useMemo(() => {
    if (engine === "games") return { sets };
    if (games.some((g) => g === null)) return null;
    const played = games as ChessGameResult[];
    const levelKnockout = competition === "knockout" && chessOutcome(played, competition).winner === null;
    return { chess: played, ...(advance && levelKnockout ? { advance } : {}) };
  }, [engine, sets, games, advance, competition]);

  const build = useMemo(
    () => (payload ? buildResultState({ engine, rules, payload: "chess" in payload ? { chess: payload.chess } : payload, competition, legs }) : null),
    [engine, rules, payload, competition, legs],
  );
  const chess = engine === "chess" && payload && "chess" in payload ? chessOutcome(payload.chess, competition) : null;
  const level = Boolean(build?.ok && build.engine === "chess" && build.level);
  const problems: ResultProblem[] = engine === "games" ? liveProblems : build && !build.ok ? build.problems : [];
  const ready = Boolean(build?.ok) && problems.length === 0 && (!level || !canDecideAdvance || advance !== null);
  const name = (k: TeamKey) => (k === "A" ? sideA : sideB);
  const winner: TeamKey | null = !build?.ok ? null : build.engine === "games" ? build.winner : level ? advance : build.winner;

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const banner =
    error || (serverProblems && serverProblems.length > 0) ? (
      <View accessibilityLiveRegion="assertive" accessibilityRole="alert" style={{ borderRadius: 14, padding: 12, backgroundColor: t.chip, borderWidth: 1, borderColor: t.live, gap: 4 }}>
        <Body tone="live" weight="semi" size={14}>{error ?? "The result was not recorded."}</Body>
        {serverProblems && serverProblems.length > 1
          ? serverProblems.map((p, i) => (
              <Body key={i} tone="live" size={12.5}>{`• ${p.message}`}</Body>
            ))
          : null}
      </View>
    ) : null;

  /* ---------- steps 2 and 3: the result read back ---------- */
  if (step !== "enter" && build?.ok) {
    const summary = build.engine === "games" ? finalScoreSummary(build.state as ScoreState) : null;
    const line = summary ? summary.setsWinnerFirst : chess ? chessScoreLine(chess.points) : "";
    return (
      <View style={{ gap: 12 }}>
        {banner}
        <Display size={20} accessibilityRole="header">{step === "summary" ? "Check the result" : correcting ? "Replace the recorded score?" : "Record this result?"}</Display>
        <View
          style={{ flexDirection: "row", gap: 10 }}
          accessible
          accessibilityLabel={winner ? `${name(winner)} wins${line ? ` ${line}` : ""}${level ? ", advances" : ""}` : chess ? `Level, ${line}` : line}
        >
          {(["A", "B"] as TeamKey[]).map((k) => {
            const won = winner === k;
            const count = summary ? (k === "A" ? summary.setsWon.a : summary.setsWon.b) : chess ? chessScoreLine(chess.points).split(" - ")[k === "A" ? 0 : 1] : "";
            return (
              <View
                key={k}
                style={{
                  flex: 1,
                  alignItems: "center",
                  gap: 4,
                  padding: 14,
                  borderRadius: 18,
                  borderWidth: won ? 2 : 1,
                  borderColor: won ? t.success : t.line,
                  backgroundColor: won ? t.chip : "transparent",
                  opacity: won || !winner ? 1 : 0.75,
                }}
              >
                <Body weight="bold" size={14} numberOfLines={2} style={{ textAlign: "center" }}>{name(k)}</Body>
                <Num size={44}>{String(count)}</Num>
                {won ? <Eyebrow size={10.5} style={{ color: t.success }}>{level ? "Winner · advances" : "Winner"}</Eyebrow> : <Eyebrow size={10.5} tone="ink3"> </Eyebrow>}
              </View>
            );
          })}
        </View>
        {summary ? (
          <Body size={15} style={{ textAlign: "center" }}>
            <Body weight="bold" size={15}>{winner ? name(winner) : ""}</Body>
            {` wins ${summary.setsWinnerFirst}`}
          </Body>
        ) : null}
        {chess && level && !advance ? <Body size={13} style={{ color: t.warning, textAlign: "center" }}>Level: the organiser decides who advances. The match stays open until then.</Body> : null}
        {step === "summary" ? (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button kind="ghost" label="Keep editing" onPress={() => setStep("enter")} style={{ flex: 1 }} />
            <Button label="Confirm" onPress={() => setStep("confirm")} style={{ flex: 1 }} />
          </View>
        ) : (
          <>
            <Body tone="ink2" size={12.5}>
              {`${correcting ? "The score recorded so far is replaced and the change is logged. " : ""}Standings, the draw, points and the screens update as soon as it reaches the server.`}
            </Body>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button kind="ghost" label="Back" disabled={busy} onPress={() => setStep("enter")} style={{ flex: 1 }} />
              <Button label={busy ? "Recording…" : correcting ? "Replace result" : "Record result"} disabled={busy || !payload} onPress={() => payload && onSubmit(payload)} style={{ flex: 1 }} />
            </View>
            {note ? <Body tone="ink3" size={12}>{note}</Body> : null}
          </>
        )}
      </View>
    );
  }

  /* ---------- step 1: enter ---------- */
  return (
    <View style={{ gap: 12 }}>
      {banner}
      <Display size={20} accessibilityRole="header">{correcting ? "Correct the result" : "Enter the final result"}</Display>
      {correcting ? <Body size={12.5} style={{ color: t.warning }}>This match already has a score. The result you enter replaces it, and the change is logged.</Body> : null}

      {engine === "games" ? (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 10 }}>
            <View style={{ width: 92 }} />
            <Body weight="bold" size={13} numberOfLines={2} style={{ flex: 1, textAlign: "center" }}>{sideA}</Body>
            <Body weight="bold" size={13} numberOfLines={2} style={{ flex: 1, textAlign: "center" }}>{sideB}</Body>
          </View>
          {shown.map((r) => {
            const row = rows[r.index];
            const what = r.kind === "match_tiebreak" ? "match tie-break points" : `set ${r.index + 1} games`;
            return (
              <View key={r.index} style={{ gap: 6 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <Eyebrow size={10.5} style={{ width: 92 }}>{r.label}</Eyebrow>
                  <View style={{ flex: 1, alignItems: "center" }}>
                    <ScoreField value={row.a} onChange={(v) => setRow(r.index, { a: v })} label={`${sideA} ${what}`} />
                  </View>
                  <View style={{ flex: 1, alignItems: "center" }}>
                    <ScoreField value={row.b} onChange={(v) => setRow(r.index, { b: v })} label={`${sideB} ${what}`} />
                  </View>
                </View>
                {r.tiebreak && r.tiebreakLoser ? (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <Body tone="ink2" size={12} style={{ width: 92 }}>Tie-break</Body>
                    <Body tone="ink2" size={12.5} style={{ flex: 1 }}>{`${name(r.tiebreakLoser)}'s points in the tie-break`}</Body>
                    <ScoreField value={row.tb} onChange={(v) => setRow(r.index, { tb: v })} label={`Set ${r.index + 1} tie-break: ${name(r.tiebreakLoser)}'s points`} wide />
                  </View>
                ) : null}
              </View>
            );
          })}
          <Body tone="ink3" size={12}>A 7-6 set needs the tie-break points of the side that lost it (7-6(5): type 5). A match tie-break is entered as its points (10-8).</Body>
        </View>
      ) : (
        <View style={{ gap: 12 }}>
          {games.map((g, i) => (
            <View key={i} style={{ gap: 6 }}>
              <Eyebrow size={10.5}>{`Game ${i + 1} · ${i % 2 === 0 ? sideA : sideB} has White`}</Eyebrow>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {(["A", "draw", "B"] as ChessGameResult[]).map((r) => (
                  <Choice
                    key={r}
                    on={g === r}
                    label={r === "draw" ? "Draw" : `${name(r as TeamKey)} won`}
                    a11y={`Game ${i + 1}: ${r === "draw" ? "draw" : `${name(r as TeamKey)} won`}`}
                    onPress={() => setGames((gs) => gs.map((x, j) => (j === i ? r : x)))}
                  />
                ))}
              </View>
            </View>
          ))}
          {level && canDecideAdvance ? (
            <View style={{ gap: 6 }}>
              <Body size={13} weight="semi" style={{ color: t.warning }}>The pairing is level. Who advances?</Body>
              <View style={{ flexDirection: "row", gap: 8 }}>
                {(["A", "B"] as TeamKey[]).map((k) => (
                  <Choice key={k} on={advance === k} label={name(k)} a11y={`${name(k)} advances`} onPress={() => setAdvance(k)} />
                ))}
              </View>
            </View>
          ) : null}
          {level && !canDecideAdvance ? <Body size={12.5} style={{ color: t.warning }}>The pairing is level: it is recorded as level and the organiser decides who advances.</Body> : null}
        </View>
      )}

      {problems.length > 0 && (sets.length > 0 || engine === "chess") ? (
        <View accessibilityLiveRegion="polite" style={{ gap: 2 }}>
          {problems.slice(0, 3).map((p, i) => (
            <Body key={i} size={12.5} style={{ color: t.warning }}>{p.message}</Body>
          ))}
        </View>
      ) : null}

      <View style={{ flexDirection: "row", gap: 8 }}>
        {onCancel ? <Button kind="ghost" label="Cancel" disabled={busy} onPress={onCancel} style={{ flex: 1 }} /> : null}
        <Button label="Check result" disabled={!ready || busy} onPress={() => setStep("summary")} style={{ flex: 1 }} />
      </View>
    </View>
  );
}
