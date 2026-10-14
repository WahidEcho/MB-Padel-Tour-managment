import { useMemo, useState } from "react";
import { Linking, Platform, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { monthLabel, type MTournamentCard } from "@core";
import { useMyLeagues, useOrg } from "../../api/queries";
import { session } from "../../state/session";
import { dateRange } from "../../api/model";
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
  return (
    <Card onPress={() => openTournament(c.slug)} accessibilityLabel={[c.name, c.liveCount ? `${c.liveCount} live` : null, [c.venue, c.city].filter(Boolean).join(", ")].filter(Boolean).join(". ")} style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        {c.liveCount ? <LivePill label={`${c.liveCount} LIVE`} /> : <Chip label={c.status === "completed" ? "Results" : dateRange(c.startsOn, c.endsOn) || "Upcoming"} />}
        <Eyebrow size={10}>{c.sport}</Eyebrow>
      </View>
      <Body weight="bold" size={16}>{c.name}</Body>
      <Body tone="ink2" size={12.5}>{[c.venue, c.city].filter(Boolean).join(", ") || `${c.teamCount} teams`}</Body>
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
  const q = useOrg(slug);
  const following = useFollowing("organization", slug);
  const [busy, setBusy] = useState(false);
  // Its 'Members only' / 'Invite only' leagues this account may see come with the account's leagues (never the shared page).
  const user = session.use((s) => s.user);
  const my = useMyLeagues(Boolean(user));
  if (!q.data) {
    return (
      <Screen tabs={false} onRefresh={() => q.refetch()}>
        <BackHeader label="Back" />
        <LoadState queries={[q]} what="this organisation" notFound={<Empty title="Organisation not found" body="It may not be on Move Score yet." />} />
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
      <BackHeader label="Back" />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 4 }}>
        {o.logoUrl ? (
          <Image source={{ uri: o.logoUrl }} style={{ width: 64, height: 64, borderRadius: 14, backgroundColor: t.surface }} contentFit="contain" accessibilityLabel={`${o.name} logo`} />
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          {o.city || o.country ? <Eyebrow>{[o.city, o.country].filter(Boolean).join(" · ")}</Eyebrow> : null}
          <Display size={26} style={{ marginTop: 4 }}>{o.name}</Display>
        </View>
      </View>

      <Card style={{ marginTop: 16, gap: 10, borderColor: following ? t.ball : t.line, borderWidth: following ? 1.5 : 1 }}>
        <Body weight="bold" size={16}>{following ? `You follow ${o.name}` : `Follow ${o.name}`}</Body>
        <Body tone="ink2" size={13}>{following ? "It is on your Following tab." : "Keep its tournaments one tap away on your Following tab."}</Body>
        <Button kind={following ? "ghost" : "primary"} label={following ? "✓ Following" : "+ Follow"} disabled={busy} onPress={() => void follow()} />
      </Card>

      {o.about ? (
        <>
          <SectionHeader title="About" />
          <Body tone="ink2" size={14}>{o.about}</Body>
        </>
      ) : null}

      {o.venues.length > 0 && <SectionHeader title={o.venues.length === 1 ? "Venue" : "Venues"} />}
      {o.venues.map((v) => (
        <Card key={v.name} onPress={v.address ? () => openMaps([v.name, v.address].join(", ")) : undefined} accessibilityLabel={[v.name, v.address, v.courts ? `${v.courts} courts` : null].filter(Boolean).join(", ")} style={{ gap: 2 }}>
          <Body weight="bold">{v.name}</Body>
          {v.address || v.courts ? <Body tone="ink2" size={12.5}>{[v.address, v.courts ? `${v.courts} ${v.courts === 1 ? "court" : "courts"}` : null].filter(Boolean).join(" · ")}</Body> : null}
        </Card>
      ))}

      {tournaments.live.length > 0 && <SectionHeader title="Live now" />}
      {tournaments.live.map((c) => <TournamentLine key={c.id} c={c} />)}
      {tournaments.upcoming.length > 0 && <SectionHeader title="Tournaments" />}
      {tournaments.upcoming.map((c) => <TournamentLine key={c.id} c={c} />)}
      {tournaments.past.length > 0 && <SectionHeader title="Results" />}
      {tournaments.past.map((c) => <TournamentLine key={c.id} c={c} />)}
      {!any && <Empty title="No public tournaments yet" body="Its tournaments appear here once they are published." />}

      {leagues.length > 0 && <SectionHeader title="Leagues" />}
      <View style={{ gap: 8 }}>
        {leagues.map((l) => <LeagueLine key={l.slug} l={l} />)}
      </View>

      {topBoard && (
        <>
          <SectionHeader title="Top of all leagues" action="All clubs" onAction={openLeagues} />
          <Body tone="ink2" size={12.5} style={{ marginBottom: 8 }}>{`${o.name}'s leagues, ${monthLabel(topBoard.month)}`}</Body>
          <BoardTable lines={topBoard.lines} limit={10} empty="No league results this month yet." />
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
