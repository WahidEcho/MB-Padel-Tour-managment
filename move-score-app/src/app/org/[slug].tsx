import { useMemo, useState } from "react";
import { Linking, Platform, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import type { MTournamentCard } from "@core";
import { useMyLeagues, useOrg } from "../../api/queries";
import { session } from "../../state/session";
import { dateRange, monthName, sportName } from "../../api/model";
import { useT } from "../../i18n";
import { toggleFollow, useFollowing } from "../../state/follows";
import { SkinScope, useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card, Chip, Empty, LivePill, SectionHeader } from "../../ui/Bits";
import { LoadState } from "../../ui/LoadState";
import { openLeagues, openTournament } from "../../nav/links";
import { BoardTable, LeagueLine } from "../../ui/Board";

/** The venue in the phone's maps app. */
function openMaps(place: string) {
  const q = encodeURIComponent(place);
  void Linking.openURL(Platform.OS === "ios" ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`).catch(() => {});
}

function TournamentLine({ c }: { c: MTournamentCard }) {
  const tr = useT();
  return (
    <Card onPress={() => openTournament(c.slug)} accessibilityLabel={[c.name, c.liveCount ? tr("screens.liveN", { n: c.liveCount }) : null, [c.venue, c.city].filter(Boolean).join(", ")].filter(Boolean).join(". ")} style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        {c.liveCount ? <LivePill label={tr("screens.liveCount", { n: c.liveCount })} /> : <Chip label={c.status === "completed" ? tr("screens.results") : dateRange(c.startsOn, c.endsOn) || tr("screens.upcoming")} />}
        <Eyebrow size={10}>{sportName(c.sport)}</Eyebrow>
      </View>
      <Body weight="bold" size={16}>{c.name}</Body>
      <Body tone="ink2" size={12.5}>{[c.venue, c.city].filter(Boolean).join(", ") || tr("screens.teams", { count: c.teamCount })}</Body>
    </Card>
  );
}

/**
 * A club, academy or organiser: who they are, their venues, tournaments and
 * leagues, its top board this month, and a follow. Opened from a tournament's
 * page or movescore://org/<slug>.
 */
function OrgPage({ slug }: { slug: string }) {
  const { t } = useTheme();
  const tr = useT();
  const q = useOrg(slug);
  const following = useFollowing("organization", slug);
  const [busy, setBusy] = useState(false);
  // Its 'Members only' / 'Invite only' leagues this account may see come with the account's leagues (never the shared page).
  const user = session.use((s) => s.user);
  const my = useMyLeagues(Boolean(user));
  if (!q.data) {
    return (
      <Screen tabs={false} onRefresh={() => q.refetch()}>
        <BackHeader label={tr("common.back")} />
        <LoadState queries={[q]} what={tr("screens.whatOrg")} notFound={<Empty title={tr("screens.orgNotFound")} body={tr("screens.orgNotFoundBody")} />} />
      </Screen>
    );
  }
  // An older server may still answer without leagues (Phase 7): nothing to show then.
  const { organization: o, tournaments } = q.data;
  const publicLeagues = q.data.leagues ?? [];
  const leagues = [
    ...publicLeagues,
    ...(user ? (my.data?.visible ?? []) : []).filter((l) => l.organization?.slug === slug && !publicLeagues.some((p) => p.slug === l.slug)),
  ];
  const topBoard = q.data.topBoard ?? null;
  const any = tournaments.live.length + tournaments.upcoming.length + tournaments.past.length > 0;
  const follow = async () => {
    setBusy(true);
    try {
      await toggleFollow("organization", slug, null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen tabs={false} onRefresh={() => q.refetch()}>
      <BackHeader label={tr("common.back")} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 4 }}>
        {o.logoUrl ? (
          <Image source={{ uri: o.logoUrl }} style={{ width: 64, height: 64, borderRadius: 14, backgroundColor: t.surface }} contentFit="contain" accessibilityLabel={tr("screens.logo", { name: o.name })} />
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          {o.city || o.country ? <Eyebrow>{[o.city, o.country].filter(Boolean).join(" · ")}</Eyebrow> : null}
          <Display size={26} style={{ marginTop: 4 }}>{o.name}</Display>
        </View>
      </View>

      <Card style={{ marginTop: 16, gap: 10, borderColor: following ? t.ball : t.line, borderWidth: following ? 1.5 : 1 }}>
        <Body weight="bold" size={16}>{following ? tr("screens.youFollowName", { name: o.name }) : tr("screens.followName", { name: o.name })}</Body>
        <Body tone="ink2" size={13}>{following ? tr("screens.orgFollowingBody") : tr("screens.orgFollowBody")}</Body>
        <Button kind={following ? "ghost" : "primary"} label={following ? tr("screens.followingBtn") : tr("screens.followBtn")} disabled={busy} onPress={() => void follow()} />
      </Card>

      {o.about ? (
        <>
          <SectionHeader title={tr("screens.about")} />
          <Body tone="ink2" size={14}>{o.about}</Body>
        </>
      ) : null}

      {o.venues.length > 0 && <SectionHeader title={o.venues.length === 1 ? tr("screens.venue") : tr("screens.venues")} />}
      {o.venues.map((v) => (
        <Card key={v.name} onPress={v.address ? () => openMaps([v.name, v.address].join(", ")) : undefined} accessibilityLabel={[v.name, v.address, v.courts ? tr("screens.courts", { count: v.courts }) : null].filter(Boolean).join(", ")} style={{ gap: 2 }}>
          <Body weight="bold">{v.name}</Body>
          {v.address || v.courts ? <Body tone="ink2" size={12.5}>{[v.address, v.courts ? tr("screens.courts", { count: v.courts }) : null].filter(Boolean).join(" · ")}</Body> : null}
        </Card>
      ))}

      {tournaments.live.length > 0 && <SectionHeader title={tr("screens.liveNow")} />}
      {tournaments.live.map((c) => <TournamentLine key={c.id} c={c} />)}
      {tournaments.upcoming.length > 0 && <SectionHeader title={tr("screens.tournaments")} />}
      {tournaments.upcoming.map((c) => <TournamentLine key={c.id} c={c} />)}
      {tournaments.past.length > 0 && <SectionHeader title={tr("screens.results")} />}
      {tournaments.past.map((c) => <TournamentLine key={c.id} c={c} />)}
      {!any && <Empty title={tr("screens.noPublicTitle")} body={tr("screens.noPublicBody")} />}

      {leagues.length > 0 && <SectionHeader title={tr("screens.leagues")} />}
      <View style={{ gap: 8 }}>
        {leagues.map((l) => <LeagueLine key={l.slug} l={l} />)}
      </View>

      {topBoard && (
        <>
          <SectionHeader title={tr("screens.topLeagues")} action={tr("screens.allClubs")} onAction={openLeagues} />
          <Body tone="ink2" size={12.5} style={{ marginBottom: 8 }}>{tr("screens.orgLeaguesMonth", { name: o.name, month: monthName(topBoard.month) })}</Body>
          <BoardTable lines={topBoard.lines} limit={10} empty={tr("screens.noResultsMonth")} />
        </>
      )}
    </Screen>
  );
}

export default function OrgScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const q = useOrg(slug);
  const primary = q.data?.organization.colors.primary ?? null;
  const accent = q.data?.organization.colors.accent ?? null;
  const skin = useMemo(() => (primary || accent ? { seedA: primary, seedB: accent } : null), [primary, accent]);
  return (
    <SkinScope skin={skin}>
      <OrgPage slug={slug ?? ""} />
    </SkinScope>
  );
}
