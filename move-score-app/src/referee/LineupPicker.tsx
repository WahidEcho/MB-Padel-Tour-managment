/**
 * The court referee's line-up screen in the app (the web console has its own):
 * before the tie each nation's two singles players from its squad (order of merit,
 * No. 1 first), after the singles the doubles pair. No approval step. A breach of an
 * ITF rule is a warning with its "ITF Reg. 43" link (opens the regulation page in the
 * browser); the referee may accept it, and the master referees and the organiser are
 * told at once. After the lock a change needs a reason. Server:
 * /api/mobile/v1/referee/matches/[matchId]/lineup (same checks, lineupRules.ts).
 */
import { useMemo, useState } from "react";
import { Linking, Pressable, TextInput, View } from "react-native";
import * as Haptics from "expo-haptics";
import { changedRubbers, checkLineup, doublesOf, needsReason, regulationPath, warningsForChange, type LineupDraft, type LineupIssue, type LineupPickerModel, type PickerSide, type SquadMember } from "@core";
import { api, ApiError } from "../api/client";
import { config } from "../config";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display, Eyebrow } from "../ui/Text";
import { Button, Card } from "../ui/Bits";
import { tr as trNow, useT } from "../i18n";
import { issueMessage } from "./words";

type Side = "A" | "B";
type Slot = "S1" | "S2" | "D1" | "D2";
/** "Singles 1", "Doubles player 2" in the app's language. */
export const slotLabel = (s: Slot) => trNow(`referee.slot_${s}`);

const copy = (l: LineupDraft): LineupDraft => ({ S1: l.S1, S2: l.S2, D: [l.D[0] ?? null, l.D[1] ?? null] });
/** What the picker starts from: each side's line-up, or the coach's submission waiting to be confirmed. */
const startDrafts = (p: LineupPickerModel): Record<Side, LineupDraft> => ({
  A: copy(p.coach?.A?.pending ? p.coach.A.lineup : p.sides.A.lineup),
  B: copy(p.coach?.B?.pending ? p.coach.B.lineup : p.sides.B.lineup),
});
const get = (d: LineupDraft, s: Slot) => (s === "D1" ? (d.D[0] ?? null) : s === "D2" ? (d.D[1] ?? null) : d[s]);
function put(d: LineupDraft, s: Slot, id: string | null): LineupDraft {
  const n = copy(d);
  if (s === "D1") n.D[0] = id;
  else if (s === "D2") n.D[1] = id;
  else n[s] = id;
  return n;
}

export const openRegulation = (reg: string) => void Linking.openURL(`${config.apiBaseUrl}${regulationPath(reg)}`);

/** What IssueLine shows: plain words, or a checker's issue (its code rebuilds the words in the app's language). */
export type IssueLike = Pick<LineupIssue, "message" | "reg"> & { code?: LineupIssue["code"]; key?: string; issueKey?: string; rubbers?: string[] };

/** A problem or warning: its words, then the tappable "ITF Reg. 43". `squad` names the players a warning is about. */
export function IssueLine({ issue, tone = "ink", squad }: { issue: IssueLike; tone?: "ink" | "live"; squad?: SquadMember[] }) {
  const tr = useT();
  const words = issue.code ? issueMessage({ code: issue.code, message: issue.message, key: issue.issueKey ?? issue.key, rubbers: issue.rubbers }, squad) : issue.message;
  return (
    <Body weight="semi" size={14} tone={tone}>
      {words}
      {issue.reg ? (
        <>
          {" "}
          <Body weight="bold" size={14} tone="blue" style={{ textDecorationLine: "underline" }} onPress={() => openRegulation(issue.reg!)} accessibilityRole="link">
            {tr("referee.itfReg", { reg: issue.reg })}
          </Body>
          .
        </>
      ) : null}
    </Body>
  );
}

export function LineupPicker({ initial, onSaved }: { initial: LineupPickerModel; onSaved?: (p: LineupPickerModel) => void }) {
  const { t } = useTheme();
  const tr = useT();
  const [picker, setPicker] = useState(initial);
  const [drafts, setDrafts] = useState<Record<Side, LineupDraft>>(startDrafts(initial));
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [editAll, setEditAll] = useState(false);
  const [doublesNow, setDoublesNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const editable = (type: "S1" | "S2" | "D") => picker.rubbers.find((r) => r.type === type)?.editable ?? false;
  const coachPending = Boolean(picker.coach?.A?.pending || picker.coach?.B?.pending);
  const showSingles = editAll || picker.step === "singles" || coachPending;
  const showDoubles = editAll || picker.step === "doubles" || (picker.step === "doubles_later" && doublesNow);

  const checks = useMemo(() => {
    const out = {} as Record<Side, { problems: (LineupIssue & { side: Side })[]; warnings: (LineupIssue & { side: Side; issueKey: string })[]; changed: boolean; late: boolean }>;
    for (const s of ["A", "B"] as const) {
      const side = picker.sides[s];
      const c = checkLineup(drafts[s], side.squad, { retired: side.retired, open: side.open });
      const changed = changedRubbers(side.lineup, drafts[s]);
      out[s] = {
        problems: c.problems.map((p) => ({ ...p, side: s })),
        warnings: warningsForChange(c, changed).map((w) => ({ ...w, key: `${s}:${w.key}`, issueKey: w.key, side: s })),
        changed: changed.length > 0,
        late: needsReason(picker.tie.locked, side.lineup, drafts[s]),
      };
    }
    return out;
  }, [drafts, picker]);
  const anyChange = checks.A.changed || checks.B.changed;
  const problems = (["A", "B"] as const).flatMap((s) => (checks[s].changed ? checks[s].problems : []));
  const warnings = [...checks.A.warnings, ...checks.B.warnings];
  const late = checks.A.late || checks.B.late;
  const canSave = anyChange && !problems.length && warnings.every((w) => accepted.has(w.key)) && (!late || reason.trim().length > 0) && !busy;

  const save = async () => {
    setBusy(true);
    setErr(null);
    setDone(null);
    const lineups: Partial<Record<Side, LineupDraft>> = {};
    for (const s of ["A", "B"] as const) if (checks[s].changed) lineups[s] = drafts[s];
    try {
      const r = await api<{ picker: LineupPickerModel; locked: boolean; accepted: unknown[] }>(`/api/mobile/v1/referee/matches/${picker.matchId}/lineup`, {
        who: "staff",
        body: { lineups, accept: [...accepted], reason: reason.trim() || undefined },
      });
      setPicker(r.picker);
      setDrafts(startDrafts(r.picker));
      setAccepted(new Set());
      setReason("");
      setEditAll(false);
      setDoublesNow(false);
      setDone(`${r.locked ? tr("referee.savedLocked") : tr("referee.saved")}${r.accepted?.length ? ` ${tr("referee.exceptionTold")}` : ""}`);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onSaved?.(r.picker);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : tr("referee.noConnSaved"));
    } finally {
      setBusy(false);
    }
  };

  const slot = (s: Side, sl: Slot, side: PickerSide) => {
    const type = sl === "D1" || sl === "D2" ? "D" : sl;
    const value = get(drafts[s], sl);
    const can = editable(type) && !busy;
    return (
      <View key={sl} style={{ gap: 6 }}>
        <Eyebrow size={10}>{slotLabel(sl)}</Eyebrow>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {side.squad.map((p, i) => {
            const on = value === p.id;
            return (
              <Pressable
                key={p.id}
                disabled={!can}
                onPress={() => setDrafts((d) => ({ ...d, [s]: put(d[s], sl, on ? null : p.id) }))}
                accessibilityRole="radio"
                accessibilityState={{ selected: on, disabled: !can }}
                accessibilityLabel={tr("referee.slotA11y", { slot: slotLabel(sl), n: i + 1, name: p.name })}
                style={{ paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, minHeight: 44, justifyContent: "center", backgroundColor: on ? t.btnBg : t.chip, borderWidth: 1, borderColor: on ? t.btnBg : t.line, opacity: can ? 1 : 0.5 }}
              >
                <Body weight={on ? "bold" : "semi"} size={14} style={{ color: on ? t.btnInk : t.ink }}>
                  {tr("referee.squadEntry", { n: i + 1, name: side.retired.includes(p.id) ? tr("referee.retiredTag", { name: p.name }) : p.name })}
                </Body>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  };

  const named = (side: PickerSide) => {
    const n = (id: string | null) => (id ? (side.squad.find((p) => p.id === id)?.name ?? "?") : "—");
    const d = doublesOf(side.lineup);
    return <Body tone="ink2" size={13}>{tr("referee.namedLine", { s1: n(side.lineup.S1), s2: n(side.lineup.S2), d: d ? d.map(n).join(" / ") : tr("referee.toBeNamed") })}</Body>;
  };

  const title = editAll
    ? tr("referee.titleChange")
    : picker.step === "singles"
      ? tr("referee.titleSingles")
      : picker.step === "doubles"
        ? tr("referee.titleDoubles")
        : picker.step === "doubles_later"
          ? tr("referee.titleDoublesLater")
          : tr("referee.titleNamed");

  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Eyebrow size={10}>{[picker.tie.tournamentName, picker.tie.court, picker.tie.round, picker.tie.locked ? tr("referee.singlesLocked") : null].filter(Boolean).join(" · ")}</Eyebrow>
        <Display size={22}>{title}</Display>
        {picker.step === "singles" && !editAll ? <IssueLine issue={{ message: tr("referee.stepSingles"), reg: "43" }} /> : null}
        {picker.step === "doubles" && !editAll ? <IssueLine issue={{ message: tr("referee.stepDoubles"), reg: "43" }} /> : null}
        {picker.step === "doubles_later" && !editAll ? <IssueLine issue={{ message: tr("referee.stepDoublesLater"), reg: "43" }} /> : null}
        {picker.step === "doubles_later" && !editAll && !doublesNow && editable("D") ? <Body tone="blue" weight="semi" onPress={() => setDoublesNow(true)}>{tr("referee.nameItNow")}</Body> : null}
      </View>
      {(["A", "B"] as const).map((s) => {
        const side = picker.sides[s];
        return (
          <Card key={s} style={{ gap: 10 }}>
            <Body weight="bold" size={16}>{`${side.code ? `${side.code} · ` : ""}${side.nation}`}</Body>
            {picker.coach?.[s] ? (
              <View style={{ gap: 4, padding: 12, borderRadius: 12, backgroundColor: picker.coach[s]!.pending ? t.chip : "transparent", borderWidth: picker.coach[s]!.pending ? 1 : 0, borderColor: t.line }}>
                <Body weight={picker.coach[s]!.pending ? "bold" : "semi"} size={13} tone={picker.coach[s]!.pending ? "ink" : "ink3"}>
                  {picker.coach[s]!.pending ? tr("referee.coachPrefilled", { note: picker.coach[s]!.note }) : tr("referee.coachDone", { note: picker.coach[s]!.note })}
                </Body>
                {picker.coach[s]!.accepted.map((a, i) => (
                  <IssueLine key={i} issue={{ reg: a.reg, message: tr("referee.coachAccepted", { message: issueMessage(a, side.squad) }) }} />
                ))}
              </View>
            ) : null}
            {showSingles || showDoubles ? (
              <>
                {showSingles && (["S1", "S2"] as Slot[]).map((x) => slot(s, x, side))}
                {showDoubles && (["D1", "D2"] as Slot[]).map((x) => slot(s, x, side))}
              </>
            ) : (
              named(side)
            )}
          </Card>
        );
      })}
      {problems.map((p) => (
        <IssueLine key={`${p.side}:${p.key}`} issue={p} tone="live" squad={picker.sides[p.side].squad} />
      ))}
      {warnings.map((w) => {
        const on = accepted.has(w.key);
        return (
          <Card key={w.key} style={{ gap: 8, borderWidth: 2, borderColor: t.warning }}>
            <IssueLine issue={w} squad={picker.sides[w.side].squad} />
            <Pressable
              onPress={() => setAccepted((a) => { const n = new Set(a); if (on) n.delete(w.key); else n.add(w.key); return n; })}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 44 }}
            >
              <View style={{ width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: t.ink, backgroundColor: on ? t.ink : "transparent", alignItems: "center", justifyContent: "center" }}>
                {on ? <Body weight="bold" size={14} style={{ color: t.floor }}>✓</Body> : null}
              </View>
              <Body weight="semi" size={13} style={{ flex: 1 }}>{tr("referee.acceptException")}</Body>
            </Pressable>
          </Card>
        );
      })}
      {late ? (
        <View style={{ gap: 6 }}>
          <IssueLine issue={{ message: tr("referee.lockedReason"), reg: "46" }} />
          <TextInput
            value={reason}
            onChangeText={setReason}
            maxLength={300}
            placeholder={tr("referee.reasonPlaceholder")}
            placeholderTextColor={t.ink3}
            accessibilityLabel={tr("referee.reasonA11y")}
            style={{ backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, color: t.ink, fontSize: 16 }}
          />
        </View>
      ) : null}
      {showSingles || showDoubles ? (
        <Button label={busy ? tr("common.saving") : picker.tie.locked ? tr("referee.saveChange") : showSingles ? tr("referee.confirmSingles") : tr("referee.confirmDoubles")} disabled={!canSave} onPress={() => void save()} />
      ) : null}
      {!editAll && picker.step !== "singles" && picker.rubbers.some((r) => r.editable) ? <Button kind="ghost" label={tr("referee.titleChange")} onPress={() => setEditAll(true)} /> : null}
      {editAll ? (
        <Button
          kind="ghost"
          label={tr("common.cancel")}
          onPress={() => {
            setEditAll(false);
            setDrafts(startDrafts(picker));
          }}
        />
      ) : null}
      {err ? <Body tone="live" weight="semi">{err}</Body> : null}
      {done ? <Body weight="semi" style={{ color: t.success }}>{done}</Body> : null}
    </View>
  );
}
