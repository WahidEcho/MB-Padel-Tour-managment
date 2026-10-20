/**
 * The coach's "Enter line-up" flow (only while the event's coach line-up switch is on):
 * their own team's two singles players from the squad (order of merit, No. 1 first) and,
 * if they wish, the doubles pair ("to be named" until after the singles). The same chips,
 * checks and regulation links as the court referee's picker (referee/LineupPicker.tsx); a
 * warning (Reg 43, Reg 50) is sent only once the coach accepts it, and the master referees
 * and the organiser are told. The officials confirm the submission, which locks it; from
 * then on the coach only views. Server: /api/mobile/v1/coach/ties/[id]/lineup.
 */
import { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import * as Haptics from "expo-haptics";
import { checkCoachLineup, clockIn, doublesOf, sameLineup, type LineupDraft, type LineupIssue, type MCoachLineupEntry } from "@core";
import { ApiError } from "../api/client";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Display, Eyebrow } from "../ui/Text";
import { Button, Card } from "../ui/Bits";
import { IssueLine } from "../referee/LineupPicker";
import { submitCoachLineup } from "./session";

type Slot = "S1" | "S2" | "D1" | "D2";
const SLOT_LABEL: Record<Slot, string> = { S1: "Singles 1", S2: "Singles 2", D1: "Doubles player 1", D2: "Doubles player 2" };
const copy = (l: LineupDraft): LineupDraft => ({ S1: l.S1, S2: l.S2, D: [l.D[0] ?? null, l.D[1] ?? null] });
const get = (d: LineupDraft, s: Slot) => (s === "D1" ? (d.D[0] ?? null) : s === "D2" ? (d.D[1] ?? null) : d[s]);
function put(d: LineupDraft, s: Slot, id: string | null): LineupDraft {
  const n = copy(d);
  if (s === "D1") n.D[0] = id;
  else if (s === "D2") n.D[1] = id;
  else n[s] = id;
  return n;
}
const start = (e: MCoachLineupEntry) => copy(e.submitted?.lineup ?? e.official);

export function CoachLineupPicker({ tieId, initial, tz, onDone }: { tieId: string; initial: MCoachLineupEntry; tz: string; onDone?: () => void }) {
  const { t } = useTheme();
  const [entry, setEntry] = useState(initial);
  const [draft, setDraft] = useState<LineupDraft>(start(initial));
  const [accepted, setAccepted] = useState<Set<string>>(new Set(initial.submitted?.accepted ?? []));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const check = useMemo(() => checkCoachLineup(draft, entry.squad, { retired: entry.retired, open: entry.openRubbers as LineupIssue["rubbers"] }), [draft, entry]);
  const pending = check.warnings.filter((w) => !accepted.has(w.key));
  const unchanged = entry.submitted ? sameLineup(entry.submitted.lineup, draft) && pending.length === 0 : false;
  const canSave = entry.open && !busy && !check.problems.length && !pending.length && !unchanged;
  const editable = (type: string) => entry.rubbers.find((r) => r.type === type)?.editable ?? false;
  const name = (id: string | null) => (id ? (entry.squad.find((p) => p.id === id)?.name ?? "?") : "—");

  const save = async () => {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const r = await submitCoachLineup(tieId, draft, [...accepted]);
      setEntry(r.entry);
      setDraft(start(r.entry));
      setDone(`Line-up submitted. The court referee and the master referees confirm it.${r.accepted?.length ? " The exception you accepted has been passed on to them and the organiser." : ""}`);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onDone?.();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "No connection: nothing was submitted.");
    } finally {
      setBusy(false);
    }
  };

  const slot = (sl: Slot) => {
    const type = sl === "D1" || sl === "D2" ? "D" : sl;
    const value = get(draft, sl);
    const can = entry.open && editable(type) && !busy;
    return (
      <View key={sl} style={{ gap: 6 }}>
        <Eyebrow size={10}>{SLOT_LABEL[sl]}</Eyebrow>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {entry.squad.map((p, i) => {
            const on = value === p.id;
            return (
              <Pressable
                key={p.id}
                disabled={!can}
                onPress={() => setDraft((d) => put(d, sl, on ? null : p.id))}
                accessibilityRole="radio"
                accessibilityState={{ selected: on, disabled: !can }}
                accessibilityLabel={`${SLOT_LABEL[sl]}: No. ${i + 1} ${p.name}`}
                style={{ paddingHorizontal: 12, paddingVertical: 12, borderRadius: 12, minHeight: 44, justifyContent: "center", backgroundColor: on ? t.btnBg : t.chip, borderWidth: 1, borderColor: on ? t.btnBg : t.line, opacity: can ? 1 : 0.5 }}
              >
                <Body weight={on ? "bold" : "semi"} size={14} style={{ color: on ? t.btnInk : t.ink }}>
                  {`${i + 1}. ${p.name}${entry.retired.includes(p.id) ? " (retired)" : ""}`}
                </Body>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  };

  const line = (l: LineupDraft) => `S1 ${name(l.S1)} · S2 ${name(l.S2)} · D ${doublesOf(l)?.map(name).join(" / ") ?? "to be named"}`;

  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Display size={22}>{entry.open ? (entry.submitted ? "Change your line-up" : "Enter your line-up") : "Your line-up"}</Display>
        {entry.open ? (
          <IssueLine issue={{ message: `Pick your two singles players. The higher-ranked in the order of merit plays Singles 1; the doubles pair can stay to be named until after the singles.${entry.deadline ? ` Open until ${clockIn(entry.deadline, tz)}.` : ""}`, reg: "43" }} />
        ) : (
          <Body weight="semi">{entry.closedMessage}</Body>
        )}
        {entry.submitted ? <Body size={13} tone="ink2">{`You submitted at ${clockIn(entry.submitted.at, tz)}: ${line(entry.submitted.lineup)}`}</Body> : null}
        <Body size={12} tone="ink3">{`As the referee holds it: ${line(entry.official)}`}</Body>
      </View>
      {entry.open ? (
        <>
          <Card style={{ gap: 12 }}>{(["S1", "S2", "D1", "D2"] as Slot[]).map(slot)}</Card>
          {check.problems.map((p) => (
            <IssueLine key={p.key} issue={p} tone="live" />
          ))}
          {check.warnings.map((w) => {
            const on = accepted.has(w.key);
            return (
              <Card key={w.key} style={{ gap: 12, borderWidth: 2, borderColor: t.warning }}>
                <IssueLine issue={{ ...w, message: `⚠ ${w.message}` }} />
                <Pressable
                  onPress={() => setAccepted((a) => { const n = new Set(a); if (on) n.delete(w.key); else n.add(w.key); return n; })}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 }}
                >
                  <View style={{ width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: t.ink, backgroundColor: on ? t.ink : "transparent", alignItems: "center", justifyContent: "center" }}>
                    {on ? <Body weight="bold" size={14} style={{ color: t.floor }}>✓</Body> : null}
                  </View>
                  <Body weight="semi" size={13} style={{ flex: 1 }}>I accept this exception (the master referees and the organiser are told)</Body>
                </Pressable>
              </Card>
            );
          })}
          <Button label={busy ? "Submitting…" : entry.submitted ? "Submit the change" : "Submit the line-up"} disabled={!canSave} onPress={() => void save()} />
        </>
      ) : null}
      {err ? <Body tone="live" weight="semi">{err}</Body> : null}
      {done ? <Body weight="semi" style={{ color: t.success }}>{done}</Body> : null}
    </View>
  );
}
