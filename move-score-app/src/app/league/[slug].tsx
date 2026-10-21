import { useMemo, useState } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { leagueVisibility, shiftMonth, type BoardLength, type MLeague, type MLeagueFixture, type MMyLeague } from "@core";
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
import { BoardTable, VisibilityBadge } from "../../ui/Board";
import { openMatch, openOrg, openTournament } from "../../nav/links";
import { NightTable } from "../../ui/NightTable";
import { boardName, isoDayName, leagueBadge, monthName, sportName } from "../../api/model";
import { tr as trNow, useT } from "../../i18n";

const statusText = (s: MMyLeague["status"]): string =>
  s === "active" ? trNow("screens.statusActive") : s === "pending" ? trNow("screens.statusPending") : s === "awaiting_payment" ? trNow("screens.statusAwaiting") : trNow("screens.statusRemoved");
const dayLabel = (date: string) => isoDayName(date);
const monthLabel = monthName;

function pointsSummary(p: MLeague["league"]["points"], sport: string): string {
  const parts = [trNow("screens.ptsWin", { n: p.win }), trNow("screens.ptsLoss", { n: p.loss })];
  if (sport === "chess") parts.push(trNow("screens.ptsDraw", { n: p.draw }));
  parts.push(trNow("screens.ptsWalkover", { w: p.walkoverWin, l: p.walkoverLoss }));
  if (p.streak.on) parts.push(trNow("screens.ptsStreak", { bonus: p.streak.bonus, from: p.streak.from, to: p.streak.to }));
  return parts.join(" · ");
}

/** Joining: by the league's modes, as the account's linked player. */
function JoinCard({ data, mine, refetchMine }: { data: MLeague; mine: MMyLeague | null; refetchMine: () => void }) {
  const { t } = useTheme();
  const tr = useT();
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
        <Body weight="bold" size={16}>{statusText(mine.status)}</Body>
        {mine.division ? <Body tone="ink2" size={13}>{mine.division}</Body> : null}
        {mine.status === "active" ? (
          <Body tone="ink2" size={13}>{mine.rank ? tr("screens.rankIn", { rank: mine.rank, month: monthLabel(mine.month), points: mine.points }) : tr("screens.noPointsIn", { month: monthLabel(mine.month) })}</Body>
        ) : null}
        {mine.payAtVenue ? <Body tone="ink2" size={13}>{tr("screens.payAtVenue", { fee: l.fee.membership ?? tr("screens.membershipWord") })}</Body> : null}
      </Card>
    );
  }
  if (!l.takingMembers) {
    return (
      <Card>
        <Body tone="ink2" size={13}>{tr("screens.notTaking")}</Body>
      </Card>
    );
  }
  if (!user) {
    return (
      <Card style={{ gap: 10 }}>
        <Body weight="bold" size={16}>{tr("screens.joinLeague")}</Body>
        <Body tone="ink2" size={13}>{tr("screens.joinSignInBody")}</Body>
        <Button label={tr("screens.signIn")} onPress={() => router.push("/account")} />
      </Card>
    );
  }
  if (my.data && !my.data.profileLinked) {
    return (
      <Card style={{ gap: 10 }}>
        <Body weight="bold" size={16}>{tr("screens.linkFirst")}</Body>
        <Body tone="ink2" size={13}>{tr("screens.linkFirstBody")}</Body>
        <Button label={tr("screens.enterCode")} onPress={() => router.push("/player-code")} />
      </Card>
    );
  }
  const join = async () => {
    setMsg(null);
    if (data.divisions.length > 1 && !division) {
      setMsg({ text: tr("screens.pickDivision"), bad: true });
      return;
    }
    setBusy(true);
    try {
      const r = await joinLeague(l.slug, { ...(needsCode ? { code } : {}), ...(division ? { divisionId: division } : {}) });
      setMsg({ text: r.message });
      refetchMine();
    } catch (e) {
      const text = e instanceof ApiError ? e.message : tr("screens.cantReach");
      if (e instanceof ApiError && (e.body as { code?: string } | null)?.code === "link_profile") router.push("/player-code");
      setMsg({ text, bad: true });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card style={{ gap: 10 }}>
      <Body weight="bold" size={16}>{tr("screens.joinLeague")}</Body>
      <Body tone="ink2" size={13}>
        {[
          l.joinModes.includes("approval") ? tr("screens.approves") : null,
          l.fee.membership ? tr(l.fee.payAtVenue ? "screens.membershipVenue" : "screens.membership", { fee: l.fee.membership }) : null,
          l.fee.perNight ? tr("screens.perNight", { fee: l.fee.perNight }) : null,
        ]
          .filter(Boolean)
          .join(" ") || tr("screens.openToAll")}
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
          placeholder={tr("screens.inviteCode")}
          placeholderTextColor={t.ink3}
          accessibilityLabel={tr("screens.inviteCode")}
          style={{ backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, color: t.ink, fontSize: 20, letterSpacing: 4, textAlign: "center" }}
        />
      )}
      <Button label={busy ? tr("screens.joining") : l.joinModes.includes("approval") ? tr("screens.askJoin") : tr("screens.join")} disabled={busy || (needsCode && code.trim().length < 8)} onPress={() => void join()} />
      {msg ? <Body tone={msg.bad ? "live" : "ink2"} size={13} accessibilityLiveRegion="polite">{msg.text}</Body> : null}
    </Card>
  );
}

function FixtureRow({ f }: { f: MLeagueFixture }) {
  const tr = useT();
  const label = `${f.home} ${tr("common.vs")} ${f.away}`;
  return (
    <Card
      onPress={f.matchId && f.status !== "scheduled" ? () => openMatch(f.matchId!) : undefined}
      accessibilityLabel={[label, dayLabel(f.date), f.status === "finished" ? f.score : f.status].filter(Boolean).join(". ")}
      style={{ gap: 4 }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        {f.status === "live" ? <LivePill /> : <Chip label={f.status === "finished" ? (f.score ?? tr("common.final")) : dayLabel(f.date)} />}
        <Eyebrow size={10}>{[f.round ? tr("screens.round", { n: f.round }) : null, f.division].filter(Boolean).join(" · ")}</Eyebrow>
      </View>
      <Body weight="semi" size={15}>{label}</Body>
    </Card>
  );
}

function LeaguePage({ slug }: { slug: string }) {
  const tr = useT();
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
        <BackHeader label={tr("common.back")} />
        <LoadState queries={[q]} what={tr("screens.whatLeague")} notFound={<Empty title={tr("screens.leagueNotFound")} body={user ? tr("screens.leagueNotFoundSignedIn") : tr("screens.leagueNotFoundGuest")} />} />
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
      <BackHeader label={tr("common.back")} />
      {l.organization ? (
        <Pressable accessibilityRole="link" onPress={() => openOrg(l.organization!.slug)}>
          <Eyebrow>{l.organization.name}</Eyebrow>
        </Pressable>
      ) : null}
      <Display size={26} style={{ marginTop: 4 }}>{l.name}</Display>
      {leagueBadge(leagueVisibility(l.visibility)) ? (
        <View style={{ marginTop: 6 }}>
          <VisibilityBadge label={leagueBadge(leagueVisibility(l.visibility))!} />
        </View>
      ) : null}
      <Body tone="ink2" size={13} style={{ marginTop: 4 }}>
        {[l.kind === "season" ? tr("screens.seasonFixtures") : tr("screens.leagueNights"), sportName(l.sport), l.status === "closed" ? tr("screens.closed") : null].filter(Boolean).join(" · ")}
      </Body>
      {l.about ? <Body tone="ink2" size={14} style={{ marginTop: 10 }}>{l.about}</Body> : null}

      <View style={{ marginTop: 16 }}>
        <JoinCard data={d} mine={mine} refetchMine={() => void my.refetch()} />
      </View>

      <SectionHeader title={tr("screens.board")} />
      {l.boards.length > 1 && (
        <Segments<string>
          value={String(period)}
          onChange={(k) => setPeriod(Number(k) as BoardLength)}
          options={l.boards.map((b) => ({ key: String(b), label: boardName(b) }))}
        />
      )}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <LinkChip label={tr("screens.earlier")} onPress={() => setMonth(shiftMonth(shownMonth, -d.period.length))} accessibilityLabel={tr("screens.earlierA11y")} />
        <Body weight="semi" size={13}>{periodText}</Body>
        <LinkChip label={tr("screens.later")} onPress={() => setMonth(shiftMonth(shownMonth, d.period.length))} accessibilityLabel={tr("screens.laterA11y")} />
      </View>
      {d.divisions.length > 1 && (
        <Segments<string> value={division} onChange={setDivision} options={[{ key: "all", label: tr("screens.filterAll") }, ...d.divisions.map((x) => ({ key: x.id, label: x.name }))]} />
      )}
      <BoardTable lines={lines} />
      <Body tone="ink3" size={12} style={{ marginTop: 8 }}>{pointsSummary(l.points, l.sport)}</Body>

      {d.nights.length > 0 && <SectionHeader title={tr("screens.nights")} />}
      <View style={{ gap: 8 }}>
        {d.nights.map((n) => (
          <Card key={n.slug || n.date} onPress={n.slug ? () => openTournament(n.slug) : undefined} accessibilityLabel={[n.name, n.liveCount ? tr("screens.liveN", { n: n.liveCount }) : null].filter(Boolean).join(". ")} style={{ gap: 4 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              {n.liveCount ? <LivePill label={tr("screens.liveCount", { n: n.liveCount })} /> : <Chip label={dayLabel(n.date)} />}
              {d.divisions.length > 1 ? <Eyebrow size={10}>{n.division}</Eyebrow> : null}
            </View>
            <Body weight="bold" size={15}>{n.name}</Body>
            <Body tone="ink2" size={12.5}>
              {n.matches ? [tr("screens.nightPlayed", { done: n.finished, total: n.matches }), n.publishedAt === null ? tr("screens.tableNotYet") : null].filter(Boolean).join(" · ") : tr("screens.tableNotYet")}
            </Body>
            {/* The night on now or next: its order of play per court, what is on and next. */}
            {n.table ? <NightTable table={n.table} compact /> : null}
          </Card>
        ))}
      </View>

      {upcoming.length > 0 && <SectionHeader title={tr("screens.fixtures")} />}
      <View style={{ gap: 8 }}>
        {upcoming.slice(0, 30).map((f, i) => <FixtureRow key={`${f.matchId ?? i}`} f={f} />)}
      </View>
      {results.length > 0 && <SectionHeader title={tr("screens.results")} />}
      <View style={{ gap: 8 }}>
        {results.slice(0, 30).map((f, i) => <FixtureRow key={`r-${f.matchId ?? i}`} f={f} />)}
      </View>
      {l.kind === "nights" && d.nights.length === 0 && <Empty title={tr("screens.noNightsTitle")} body={tr("screens.noNightsBody")} />}
      {l.kind === "season" && d.fixtures.length === 0 && <Empty title={tr("screens.noFixturesTitle")} body={tr("screens.noFixturesBody")} />}
    </Screen>
  );
}

export default function LeagueScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const key = useMemo(() => slug ?? "", [slug]);
  return <LeaguePage slug={key} />;
}
