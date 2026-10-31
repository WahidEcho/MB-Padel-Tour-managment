/**
 * The toss before a tennis or padel match (owner, 31 Oct 2026), in the chair umpire's console.
 * One question at a time, as the serve order: who won the toss, what they chose (serve, receive, a
 * side, or let the opponent choose), the other choice (ITF rule 4, `tossQuestion`), then in doubles
 * who serves first and who receives first. The last step shows the court as seen from the chair
 * (who stands left, who right), the server, an arrow and the receiver, and "Start the match".
 * Nothing is recorded until then: Back undoes one answer at a time. Rules in src/lib/scoring/toss.ts.
 */
import { useState } from "react";
import { Pressable, View } from "react-native";
import { answerToss, tossQuestion, tossRecord, type ServeOrder, type TeamKey, type TossAnswers, type TossQuestion, type TossRecord } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow } from "../ui/Text";
import { BALL, BALL_INK } from "../theme/palette";
import { useT } from "../i18n";
import { BigChoice, OrderLine, SIDE_HEX, type V2Side } from "./V2";

type Value = TeamKey | "serve" | "receive" | "side" | "defer" | "left" | "right";
type Step = { kind: "toss"; q: TossQuestion } | { kind: "server" } | { kind: "receiver" } | { kind: "confirm" };

const other = (k: TeamKey): TeamKey => (k === "A" ? "B" : "A");

export function TossForm({
  sides,
  doubles,
  disabled = false,
  onStart,
  onSkip,
}: {
  sides: Record<TeamKey, V2Side>;
  /** Doubles with both pairs named and the serve order on: also asks the first server and receiver. */
  doubles: boolean;
  disabled?: boolean;
  onStart: (toss: TossRecord, order: ServeOrder | null) => void;
  onSkip: () => void;
}) {
  const { t } = useTheme();
  const tr = useT();
  // Every answer pushes the answers so far; Back pops one.
  const [history, setHistory] = useState<{ toss: TossAnswers; server?: 0 | 1; receiver?: 0 | 1 }[]>([{ toss: {} }]);
  const now = history[history.length - 1];
  const record = tossRecord(now.toss);
  const q = tossQuestion(now.toss);
  const step: Step = q ? { kind: "toss", q } : doubles && now.server === undefined ? { kind: "server" } : doubles && now.receiver === undefined ? { kind: "receiver" } : { kind: "confirm" };
  const push = (next: { toss: TossAnswers; server?: 0 | 1; receiver?: 0 | 1 }) => setHistory([...history, next]);
  const name = (k: TeamKey) => sides[k].name;
  const players = (k: TeamKey): [0 | 1, string][] => [
    [0, sides[k].players[0] ?? tr("score.player1")],
    [1, sides[k].players[1] ?? tr("score.player2")],
  ];

  const question = (s: TossQuestion): { text: string; options: [Value, string][]; hint?: string } => {
    switch (s.kind) {
      case "winner":
        return { text: tr("score.tossWinner"), options: [["A", name("A")], ["B", name("B")]] };
      case "winnerChoice":
        return {
          text: tr("score.tossWinnerChose", { name: name(s.team) }),
          options: [["serve", tr("score.tossServe")], ["receive", tr("score.tossReceive")], ["side", tr("score.tossSide")], ["defer", tr("score.tossDefer", { name: name(other(s.team)) })]],
        };
      case "choice":
        return { text: tr("score.tossChooses", { name: name(s.team) }), options: [["serve", tr("score.tossServe")], ["receive", tr("score.tossReceive")], ["side", tr("score.tossSide")]] };
      case "side":
        return { text: tr("score.tossWhichSide", { name: name(s.team) }), options: [["left", tr("score.tossLeft")], ["right", tr("score.tossRight")]], hint: tr("score.tossSideHint") };
      case "serveOrReceive":
        return { text: tr("score.tossChooses", { name: name(s.team) }), options: [["serve", tr("score.tossServe")], ["receive", tr("score.tossReceive")]] };
    }
  };

  const order: ServeOrder | null =
    record && doubles && now.server !== undefined && now.receiver !== undefined
      ? { servingTeam: record.servingTeam, server: now.server, receiver: now.receiver, otherServer: 0, otherReceiver: 0 }
      : null;

  return (
    <View style={{ gap: 16 }} testID="toss">
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Eyebrow size={11} tone="ink3">{step.kind === "confirm" ? tr("score.checkAndConfirm") : tr("score.tossTitle")}</Eyebrow>
        {history.length > 1 ? (
          <Pressable accessibilityRole="button" onPress={() => setHistory(history.slice(0, -1))} hitSlop={10}>
            <Body tone="blue" weight="semi" size={14}>{tr("score.backLink")}</Body>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" testID="toss-skip" onPress={onSkip} hitSlop={10}>
            <Body tone="ink3" weight="semi" size={14}>{tr("score.tossSkip")}</Body>
          </Pressable>
        )}
      </View>

      {step.kind === "toss"
        ? (() => {
            const shown = question(step.q);
            return (
              <View style={{ gap: 10 }}>
                <BigChoice<Value> question={shown.text} value={undefined} options={shown.options} onPick={(v) => push({ toss: answerToss(now.toss, step.q, v as never) })} />
                {shown.hint ? (
                  <View style={{ backgroundColor: t.chip, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 }}>
                    <Body tone="ink2" size={13}>{shown.hint}</Body>
                  </View>
                ) : null}
              </View>
            );
          })()
        : null}

      {step.kind === "server" && record ? (
        <BigChoice question={tr("score.tossFirstServer", { name: name(record.servingTeam) })} value={undefined} options={players(record.servingTeam)} onPick={(v) => push({ ...now, server: v })} />
      ) : null}
      {step.kind === "receiver" && record ? (
        <BigChoice question={tr("score.tossFirstReceiver", { name: name(other(record.servingTeam)) })} value={undefined} options={players(other(record.servingTeam))} onPick={(v) => push({ ...now, receiver: v })} />
      ) : null}

      {step.kind === "confirm" && record ? (
        <View style={{ gap: 14 }} testID="toss-summary">
          <Body weight="semi" size={15} tone="ink2">
            {record.deferred ? tr("score.tossLetChoose", { winner: name(record.winner), name: name(record.first.team) }) : tr("score.tossWon", { name: name(record.winner) })}
          </Body>
          {/* The court as the chair umpire sees it. */}
          <View style={{ gap: 6 }}>
            <Eyebrow size={10} tone="ink3">{tr("score.tossCourt")}</Eyebrow>
            <View style={{ flexDirection: "row", gap: 8 }} testID="toss-court">
              {(["left", "right"] as const).map((at) => {
                const k = at === "left" ? record.leftTeam : other(record.leftTeam);
                return (
                  <View key={at} style={{ flex: 1, borderRadius: 14, padding: 12, borderWidth: 2, borderColor: SIDE_HEX[k], backgroundColor: t.chip, gap: 2 }}>
                    <Eyebrow size={10} tone="ink3">{at === "left" ? tr("score.tossLeft") : tr("score.tossRight")}</Eyebrow>
                    <Body weight="bold" size={16} numberOfLines={1}>{name(k)}</Body>
                    {k === record.servingTeam ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: BALL, marginTop: 4 }} /> : null}
                  </View>
                );
              })}
            </View>
          </View>
          <View style={{ backgroundColor: t.chip, borderRadius: 18, padding: 16, gap: 6 }} testID="toss-order">
            <OrderLine
              label={tr("score.serverLabel")}
              name={(order ? sides[record.servingTeam].players[order.server] : sides[record.servingTeam].players.length === 1 ? sides[record.servingTeam].players[0] : null) ?? name(record.servingTeam)}
              country={name(record.servingTeam)}
              ball
            />
            <Body size={30} weight="bold" style={{ color: t.blue, paddingLeft: 4, lineHeight: 34 }} accessibilityElementsHidden importantForAccessibility="no">↓</Body>
            <OrderLine
              label={tr("score.receiverLabel")}
              name={(order ? sides[other(record.servingTeam)].players[order.receiver] : sides[other(record.servingTeam)].players.length === 1 ? sides[other(record.servingTeam)].players[0] : null) ?? name(other(record.servingTeam))}
              country={name(other(record.servingTeam))}
            />
          </View>
          <Pressable
            testID="toss-start"
            accessibilityRole="button"
            disabled={disabled}
            onPress={() => onStart(record, order)}
            style={({ pressed }) => ({ backgroundColor: BALL, borderRadius: 18, paddingVertical: 16, alignItems: "center", opacity: disabled ? 0.5 : pressed ? 0.85 : 1 })}
          >
            <Body weight="bold" size={16} style={{ color: BALL_INK }}>{tr("score.startTheMatch")}</Body>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
