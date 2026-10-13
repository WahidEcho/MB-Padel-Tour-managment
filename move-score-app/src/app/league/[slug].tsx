import { useMemo, useState } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { BOARD_LABELS, dayLabel, monthLabel, shiftMonth, type BoardLength, type MLeague, type MLeagueFixture, type MMyLeague } from "@core";
import { ApiError } from "../../api/client";
import { joinLeague, useLeague, useMyLeagues } from "../../api/queries";
import { session } from "../../state/session";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card, Chip, Empty, LinkChip, LivePill, SectionHeader } from "../../ui/Bits";
import { LoadState } from "../../ui/LoadState";
import { Segments } from "../../ui/Segments";
import { BoardTable } from "../../ui/Board";
import { openMatch, openOrg, openTournament } from "../../nav/links";
import { NightTable } from "../../ui/NightTable";

const STATUS_TEXT: Record<MMyLeague["status"], string> = {
  active: "You're in this league",
  pending: "Your request is waiting for the organiser",
  awaiting_payment: "Approved — pay the membership to finish joining",
  removed: "The organiser removed you from this league",
};

function pointsSummary(p: MLeague["league"]["points"], sport: string): string {
  const parts = [`Win ${p.win}`, `Loss ${p.loss}`];
  if (sport === "chess") parts.push(`Draw ${p.draw}`);
  parts.push(`Walkover ${p.walkoverWin}/${p.walkoverLoss}`);
  if (p.streak.on) parts.push(`+${p.streak.bonus} for wins ${p.streak.from}–${p.streak.to} in a row`);
  return parts.join(" · ");
}

/** Joining: by the league's modes, as the account's linked player. */
function JoinCard({ data, mine, refetchMine }: { data: MLeague; mine: MMyLeague | null; refetchMine: () => void }) {
  const { t } = useTheme();
  const user = session.use((s) => s.user);
  const my = useMyLeagues(Boolean(user), data.league.slug);
  const [code, setCode] = useState("");
  const [division, setDivision] = useState<string | null>(data.divisions.length === 1 ? data.divisions[0].id : null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const l = data.league;
  const needsCode = l.joinModes.includes("invite_code");

  if (mine) {
    return (
      <Card style={{ gap: 6, borderColor: mine.status === "active" ? t.ball : t.line, borderWidth: mine.status === "active" ? 1.5 : 1 }}>
        <Body weight="bold" size={16}>{STATUS_TEXT[mine.status]}</Body>
        {mine.division ? <Body tone="ink2" size={13}>{mine.division}</Body> : null}
        {mine.status === "active" ? (
          <Body tone="ink2" size={13}>{mine.rank ? `#${mine.rank} in ${monthLabel(mine.month)} · ${mine.points} points` : `No points yet in ${monthLabel(mine.month)}`}</Body>
        ) : null}
        {mine.payAtVenue ? <Body tone="ink2" size={13}>{`Pay the ${l.fee.membership ?? "membership"} at the venue.`}</Body> : null}
      </Card>
    );
  }
  if (!l.takingMembers) {
    return (
      <Card>
        <Body tone="ink2" size={13}>This league is not taking new members.</Body>
      </Card>
    );
  }
  if (!user) {
    return (
      <Card style={{ gap: 10 }}>
        <Body weight="bold" size={16}>Join this league</Body>
        <Body tone="ink2" size={13}>Sign in, link your player profile, and your results count here.</Body>
        <Button label="Sign in" onPress={() => router.push("/account")} />
      </Card>
    );
  }
  if (my.data && !my.data.profileLinked) {
    return (
      <Card style={{ gap: 10 }}>
        <Body weight="bold" size={16}>Link your player profile first</Body>
        <Body tone="ink2" size={13}>Enter the player code the organiser sent you, then come back to join.</Body>
        <Button label="Enter my player code" onPress={() => router.push("/player-code")} />
      </Card>
    );
  }
  const join = async () => {
    setMsg(null);
    if (data.divisions.length > 1 && !division) {
      setMsg({ text: "Pick a division first.", bad: true });
      return;
    }
    setBusy(true);
    try {
      const r = await joinLeague(l.slug, { ...(needsCode ? { code } : {}), ...(division ? { divisionId: division } : {}) });
      setMsg({ text: r.message });
      refetchMine();
    } catch (e) {
      const text = e instanceof ApiError ? e.message : "Can't reach Move Score right now.";
      if (e instanceof ApiError && (e.body as { code?: string } | null)?.code === "link_profile") router.push("/player-code");
      setMsg({ text, bad: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card style={{ gap: 10 }}>
      <Body weight="bold" size={16}>Join this league</Body>
      <Body tone="ink2" size={13}>
        {[
          l.joinModes.includes("approval") ? "The organiser approves each request." : null,
          l.fee.membership ? `Membership ${l.fee.membership}${l.fee.payAtVenue ? ", paid at the venue" : ""}.` : null,
          l.fee.perNight ? `${l.fee.perNight} per night.` : null,
        ]
          .filter(Boolean)
          .join(" ") || "Open to everyone: you're in at once."}
      </Body>
      {data.divisions.length > 1 && (
        <Segments<string> value={division ?? ""} onChange={setDivision} options={data.divisions.map((d) => ({ key: d.id, label: d.name }))} />
      )}
      {needsCode && (
        <TextInput
          value={code}
          onChangeText={setCode}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          keyboardType={Platform.OS === "android" ? "visible-password" : "default"}
          placeholder="Invite code"
          placeholderTextColor={t.ink3}
          accessibilityLabel="Invite code"
          style={{ backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, color: t.ink, fontSize: 20, letterSpacing: 4, textAlign: "center" }}
        />
      )}
      <Button label={busy ? "Joining…" : l.joinModes.includes("approval") ? "Ask to join" : "Join"} disabled={busy || (needsCode && code.trim().length < 8)} onPress={() => void join()} />
      {msg ? <Body tone={msg.bad ? "live" : "ink2"} size={13} accessibilityLiveRegion="polite">{msg.text}</Body> : null}
    </Card>
  );
}

function FixtureRow({ f }: { f: MLeagueFixture }) {
  const label = `${f.home} v ${f.away}`;
  return (
    <Card
      onPress={f.matchId && f.status !== "scheduled" ? () => openMatch(f.matchId!) : undefined}
      accessibilityLabel={[label, dayLabel(f.date), f.status === "finished" ? f.score : f.status].filter(Boolean).join(". ")}
      style={{ gap: 4 }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        {f.status === "live" ? <LivePill /> : <Chip label={f.status === "finished" ? (f.score ?? "Final") : dayLabel(f.date)} />}
        <Eyebrow size={10}>{[f.round ? `Round ${f.round}` : null, f.division].filter(Boolean).join(" · ")}</Eyebrow>
      </View>
      <Body weight="semi" size={15}>{label}</Body>
    </Card>
  );
}

function LeaguePage({ slug }: { slug: string }) {
  const [period, setPeriod] = useState<BoardLength>(1);
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [division, setDivision] = useState<string>("all");
  const q = useLeague(slug, period, month);
  const user = session.use((s) => s.user);
  const my = useMyLeagues(Boolean(user), slug);
  const mine = my.data?.leagues.find((x) => x.slug === slug) ?? null;

  if (!q.data) {
    return (
      <Screen tabs={false} onRefresh={() => q.refetch()}>
        <BackHeader label="Back" />
        <LoadState queries={[q]} what="this league" notFound={<Empty title="League not found" body="It may have closed or not be public yet." />} />
      </Screen>
    );
  }
  const d = q.data;
  const l = d.league;
  const shownMonth = d.period.month;
  const lines = division === "all" ? d.board : (d.divisions.find((x) => x.id === division)?.board ?? []);
  const periodText = d.period.months.length > 1 ? `${monthLabel(d.period.months[0])} – ${monthLabel(d.period.months[d.period.months.length - 1])}` : monthLabel(shownMonth);
  const upcoming = d.fixtures.filter((f) => f.status !== "finished");
  const results = d.fixtures.filter((f) => f.status === "finished").reverse();
  return (
    <Screen tabs={false} onRefresh={() => Promise.all([q.refetch(), user ? my.refetch() : Promise.resolve()])}>
      <BackHeader label="Back" />
      {l.organization ? (
        <Pressable accessibilityRole="link" onPress={() => openOrg(l.organization!.slug)}>
          <Eyebrow>{l.organization.name}</Eyebrow>
        </Pressable>
      ) : null}
      <Display size={26} style={{ marginTop: 4 }}>{l.name}</Display>
      <Body tone="ink2" size={13} style={{ marginTop: 4 }}>
        {[l.kind === "season" ? "Season fixtures" : "League nights", l.sport, l.status === "closed" ? "Closed" : null].filter(Boolean).join(" · ")}
      </Body>
      {l.about ? <Body tone="ink2" size={14} style={{ marginTop: 10 }}>{l.about}</Body> : null}

      <View style={{ marginTop: 16 }}>
        <JoinCard data={d} mine={mine} refetchMine={() => void my.refetch()} />
      </View>

      <SectionHeader title="Board" />
      {l.boards.length > 1 && (
        <Segments<string>
          value={String(period)}
          onChange={(k) => setPeriod(Number(k) as BoardLength)}
          options={l.boards.map((b) => ({ key: String(b), label: BOARD_LABELS[b as BoardLength] ?? `${b} months` }))}
        />
      )}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <LinkChip label="‹ Earlier" onPress={() => setMonth(shiftMonth(shownMonth, -d.period.length))} accessibilityLabel="Earlier period" />
        <Body weight="semi" size={13}>{periodText}</Body>
        <LinkChip label="Later ›" onPress={() => setMonth(shiftMonth(shownMonth, d.period.length))} accessibilityLabel="Later period" />
      </View>
      {d.divisions.length > 1 && (
        <Segments<string> value={division} onChange={setDivision} options={[{ key: "all", label: "All" }, ...d.divisions.map((x) => ({ key: x.id, label: x.name }))]} />
      )}
      <BoardTable lines={lines} />
      <Body tone="ink3" size={12} style={{ marginTop: 8 }}>{pointsSummary(l.points, l.sport)}</Body>

      {d.nights.length > 0 && <SectionHeader title="Nights" />}
      <View style={{ gap: 8 }}>
        {d.nights.map((n) => (
          <Card key={n.slug || n.date} onPress={n.slug ? () => openTournament(n.slug) : undefined} accessibilityLabel={[n.name, n.liveCount ? `${n.liveCount} live` : null].filter(Boolean).join(". ")} style={{ gap: 4 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              {n.liveCount ? <LivePill label={`${n.liveCount} LIVE`} /> : <Chip label={dayLabel(n.date)} />}
              {d.divisions.length > 1 ? <Eyebrow size={10}>{n.division}</Eyebrow> : null}
            </View>
            <Body weight="bold" size={15}>{n.name}</Body>
            <Body tone="ink2" size={12.5}>
              {n.matches ? `${n.finished}/${n.matches} matches played${n.publishedAt === null ? " · table not published yet" : ""}` : "Table not published yet"}
            </Body>
            {/* The night on now or next: its order of play per court, what is on and next. */}
            {n.table ? <NightTable table={n.table} compact /> : null}
          </Card>
        ))}
      </View>

      {upcoming.length > 0 && <SectionHeader title="Fixtures" />}
      <View style={{ gap: 8 }}>
        {upcoming.slice(0, 30).map((f, i) => <FixtureRow key={`${f.matchId ?? i}`} f={f} />)}
      </View>
      {results.length > 0 && <SectionHeader title="Results" />}
      <View style={{ gap: 8 }}>
        {results.slice(0, 30).map((f, i) => <FixtureRow key={`r-${f.matchId ?? i}`} f={f} />)}
      </View>
      {l.kind === "nights" && d.nights.length === 0 && <Empty title="No nights yet" body="Nights appear here when the organiser schedules them." />}
      {l.kind === "season" && d.fixtures.length === 0 && <Empty title="No fixtures yet" body="Fixtures appear here when the organiser draws the season." />}
    </Screen>
  );
}

export default function LeagueScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const key = useMemo(() => slug ?? "", [slug]);
  return <LeaguePage slug={key} />;
}
