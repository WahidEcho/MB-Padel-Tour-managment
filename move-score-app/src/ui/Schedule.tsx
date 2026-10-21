/**
 * The order of play by day and court: a horizontal day picker (the event's own
 * days), a "By court / By time" switch, then the picked day's ties or matches.
 * What is live stays pinned on top whatever the day. Grouping is the shared pure
 * code in src/lib/schedule/orderOfPlay.ts (@core), as on the public web ties page.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import * as Haptics from "expo-haptics";
import {
  dayKeyIn,
  defaultScheduleDay,
  isDoneStatus,
  NO_COURT_TITLE,
  NO_TIME_TITLE,
  scheduleDays,
  scheduleForDay,
  TBC_DAY,
  type MMatch,
  type MTie,
  type ScheduleItem,
  type ScheduleMode,
} from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow } from "./Text";
import { Empty, SectionHeader } from "./Bits";
import { MatchMini, TieCard, TieRow } from "./Cards";
import { isOnCourt, timeIn, type View as Model } from "../api/model";
import { useT } from "../i18n";
import { fmt, tr } from "../i18n/t";

/** A day key ("2026-11-02") as weekday and date in the app's language; the "to be scheduled" bucket by name. */
function dayParts(d: string): { weekday: string; date: string; full: string } {
  if (d === TBC_DAY || !/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const label = d === TBC_DAY ? tr("schedule.toBeScheduled") : d;
    return { weekday: label, date: "", full: label };
  }
  const at = `${d}T12:00:00Z`;
  return { weekday: fmt().weekday(at, false, "UTC"), date: fmt().dayMonth(at, "UTC"), full: fmt().day(at, "UTC") };
}

/** The shared grouping's fixed titles in the app's language (court names and clock times as they are). */
function groupTitle(g: { title: string; courtId?: string | null; time?: string | null }): string {
  if (!g.courtId && g.title === NO_COURT_TITLE) return tr("schedule.courtToBeConfirmed");
  if (!g.time && g.title === NO_TIME_TITLE) return tr("schedule.timeToBeConfirmed");
  return g.title;
}

function DayPicker({ days, value, today, onChange }: { days: string[]; value: string; today: string; onChange: (d: string) => void }) {
  const { t } = useTheme();
  const tr = useT();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 2 }} style={{ marginHorizontal: -2 }}>
      {days.map((d) => {
        const on = d === value;
        const isToday = d === today;
        const parts = dayParts(d);
        const label = parts.full;
        return (
          <Pressable
            key={d}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={isToday ? tr("schedule.todayA11y", { day: label }) : label}
            onPress={() => {
              void Haptics.selectionAsync().catch(() => {});
              onChange(d);
            }}
            hitSlop={4}
            style={({ pressed }) => [
              {
                minHeight: 44,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 14,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: on ? t.btnBg : t.chip,
                borderWidth: 1,
                borderColor: on ? t.btnBg : t.line,
              },
              pressed && { opacity: 0.75 },
            ]}
          >
            {d === TBC_DAY ? (
              <Body size={12} weight="semi" style={{ color: on ? t.btnInk : t.ink }}>{label}</Body>
            ) : (
              <>
                <Eyebrow size={9.5} style={{ color: on ? t.btnInk : t.ink2 }}>{isToday ? tr("schedule.today") : parts.weekday}</Eyebrow>
                <Body size={13} weight="bold" style={{ color: on ? t.btnInk : t.ink }}>{parts.date}</Body>
              </>
            )}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function ModeSwitch({ value, onChange }: { value: ScheduleMode; onChange: (m: ScheduleMode) => void }) {
  const { t } = useTheme();
  const tr = useT();
  const opts: { key: ScheduleMode; label: string }[] = [
    { key: "court", label: tr("schedule.byCourt") },
    { key: "time", label: tr("schedule.byTime") },
  ];
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", gap: 4, backgroundColor: t.chip, padding: 3, borderRadius: 12, alignSelf: "flex-start", marginTop: 10 }}>
      {opts.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.key)}
            hitSlop={6}
            style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 9, backgroundColor: on ? t.surface : "transparent" }}
          >
            <Body size={12} weight="semi" tone={on ? "ink" : "ink2"}>{o.label}</Body>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Day picker + mode state shared by the ties and the matches schedules. */
function useScheduleState(items: ScheduleItem[], tz: string) {
  const [picked, setPicked] = useState<string | null>(null);
  const [mode, setMode] = useState<ScheduleMode>("court");
  const days = useMemo(() => scheduleDays(items, tz), [items, tz]);
  const today = dayKeyIn(new Date().toISOString(), tz);
  const day = picked && days.includes(picked) ? picked : defaultScheduleDay(days, today);
  return { days, today, day, setPicked, mode, setMode };
}

function tieItem(x: MTie, v: Model): ScheduleItem & { tie: MTie } {
  const rubbers = v.rubbers(x.id);
  return {
    id: x.id,
    courtId: x.courtId,
    scheduledTime: x.scheduledTime,
    order: x.order,
    status: x.status === "live" ? "live" : x.status === "completed" ? "done" : "scheduled",
    startedAt: rubbers.map((m) => m.startedAt).filter(Boolean).sort()[0] ?? null,
    endedAt: rubbers.map((m) => m.endedAt).filter(Boolean).sort().pop() ?? null,
    tie: x,
  };
}

/** "Group A", "Semi-final", "Places 5–8". */
function tieNote(x: MTie, v: Model): string | null {
  const group = x.groupId ? v.bundle.groups.find((g) => g.id === x.groupId)?.name : null;
  const places = x.placesFrom && x.placesTo ? (x.placesFrom === x.placesTo ? tr("schedule.place", { n: x.placesFrom }) : tr("schedule.places", { from: x.placesFrom, to: x.placesTo })) : null;
  return [x.roundName ?? group ?? (x.stage === "group" ? tr("schedule.groupStage") : null), x.roundName ? null : places].filter(Boolean).join(" · ") || null;
}

/** The Schedule tab of a nations event. */
export function TieSchedule({ ties, v }: { ties: MTie[]; v: Model }) {
  const tr = useT();
  const tz = v.bundle.tournament.timezone;
  const items = useMemo(() => ties.map((x) => tieItem(x, v)), [ties, v]);
  const s = useScheduleState(items, tz);
  const plan = useMemo(
    () => (s.day ? scheduleForDay(items, { day: s.day, timeZone: tz, courts: v.bundle.courts, mode: s.mode }) : null),
    [items, s.day, s.mode, tz, v.bundle.courts],
  );
  if (!ties.length || !s.day || !plan) return <Empty title={tr("schedule.emptyTiesTitle")} body={tr("schedule.emptyTiesBody")} />;
  return (
    <View style={{ gap: 10 }}>
      {plan.live.length > 0 && (
        <>
          <SectionHeader title={tr("schedule.liveNow")} />
          {plan.live.map((x) => (
            <TieCard key={x.id} tie={x.tie} v={v} linkTie />
          ))}
        </>
      )}
      <View style={{ marginTop: plan.live.length ? 16 : 0 }}>
        <DayPicker days={s.days} value={s.day} today={s.today} onChange={s.setPicked} />
        <ModeSwitch value={s.mode} onChange={s.setMode} />
      </View>
      {plan.groups.map((g) => (
        <View key={g.key} style={{ gap: 8 }}>
          <SectionHeader title={s.mode === "time" && g.time ? tr("schedule.notBefore", { time: g.title }) : groupTitle(g)} />
          {g.items.map((x, i) => {
            const prev = g.items[i - 1];
            const caption =
              s.mode === "time"
                ? (v.court(x.courtId) ?? tr("schedule.courtTbc"))
                : x.scheduledTime
                  ? tr("schedule.notBeforeCaps")
                  : prev
                    ? tr("schedule.followedByCaps")
                    : tr("schedule.timeTbcCaps");
            return <TieRow key={x.id} tie={x.tie} v={v} caption={caption} note={tieNote(x.tie, v)} />;
          })}
        </View>
      ))}
      {!plan.groups.length && <Empty title={tr("schedule.nothingThisDay")} />}
    </View>
  );
}

function matchItem(m: MMatch): ScheduleItem & { match: MMatch } {
  return {
    id: m.id,
    courtId: m.courtId,
    scheduledTime: m.scheduledTime,
    order: m.order,
    status: isOnCourt(m) ? "live" : isDoneStatus(m.status) || m.status === "cancelled" ? "done" : "scheduled",
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    match: m,
  };
}

/** The Matches tab of every other tournament: the same day picker, by court. */
export function MatchSchedule({ matches, v }: { matches: MMatch[]; v: Model }) {
  const tr = useT();
  const tz = v.bundle.tournament.timezone;
  const items = useMemo(() => matches.map(matchItem), [matches]);
  const s = useScheduleState(items, tz);
  const plan = useMemo(
    () => (s.day ? scheduleForDay(items, { day: s.day, timeZone: tz, courts: v.bundle.courts, mode: s.mode }) : null),
    [items, s.day, s.mode, tz, v.bundle.courts],
  );
  if (!matches.length || !s.day || !plan) return <Empty title={tr("schedule.emptyMatchesTitle")} body={tr("schedule.emptyMatchesBody")} />;
  return (
    <View style={{ gap: 8 }}>
      {plan.live.length > 0 && (
        <>
          <SectionHeader title={tr("schedule.liveNow")} />
          {plan.live.map((x) => (
            <MatchMini key={x.id} m={x.match} v={v} />
          ))}
        </>
      )}
      <View style={{ marginTop: plan.live.length ? 16 : 0 }}>
        <DayPicker days={s.days} value={s.day} today={s.today} onChange={s.setPicked} />
        <ModeSwitch value={s.mode} onChange={s.setMode} />
      </View>
      {plan.groups.map((g) => (
        <View key={g.key} style={{ gap: 8 }}>
          <SectionHeader title={s.mode === "time" && g.time ? tr("schedule.notBefore", { time: g.title }) : groupTitle(g)} />
          {g.items.map((x, i) => (
            <MatchMini
              key={x.id}
              m={x.match}
              v={v}
              timeLabel={x.scheduledTime ? tr("schedule.notBefore", { time: timeIn(x.scheduledTime, tz) }) : i > 0 ? tr("schedule.followedBy") : undefined}
            />
          ))}
        </View>
      ))}
      {!plan.groups.length && <Empty title={tr("schedule.nothingThisDay")} />}
    </View>
  );
}
