import { useMemo } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { isDoneStatus, playerRecord, playerSide, type MMatch, type WonLost } from "@core";
import { useT } from "../../i18n";
import { useBundle, useLive } from "../../api/queries";
import { isOnCourt, makeView, needsDay } from "../../api/model";
import { SkinScope, useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow, Num } from "../../ui/Text";
import { Button, Card, Chip, Empty, Flag, LinkChip, SectionHeader } from "../../ui/Bits";
import { MatchMini } from "../../ui/Cards";
import { StaleBanner } from "../../ui/Offline";
import { LoadState } from "../../ui/LoadState";
import { toggleFollow, useFollowing } from "../../state/follows";
import { isNation, openTeam, openTournament } from "../../nav/links";
import { useMyPlayer } from "../../player/me";

/** The player's photo, cropped on its focal point; their flag when there is none. */
function Portrait({ name, photoUrl, focalX, focalY, iso2, code, size }: { name: string; photoUrl: string | null; focalX?: number; focalY?: number; iso2: string | null; code: string; size: number }) {
  const { t } = useTheme();
  const tr = useT();
  if (!photoUrl) {
    return (
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: t.surface2, borderColor: t.line, borderWidth: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        <Flag iso2={iso2} code={code} size={size * 0.56} />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: photoUrl }}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: t.chip }}
      contentFit="cover"
      contentPosition={{ left: `${Math.round((focalX ?? 0.5) * 100)}%`, top: `${Math.round((focalY ?? 0.35) * 100)}%` }}
      accessibilityLabel={tr("screens.photoOf", { name })}
    />
  );
}

function RecordCard({ label, rec }: { label: string; rec: WonLost }) {
  const tr = useT();
  return (
    <Card style={{ flex: 1, gap: 2 }} accessibilityLabel={tr("screens.recordA11y", { label, won: rec.won, lost: rec.lost })}>
      <Num size={26}>{`${rec.won}–${rec.lost}`}</Num>
      <Eyebrow size={10} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{label}</Eyebrow>
    </Card>
  );
}

/**
 * Where per-player match stats (aces, first serve, points won…) go once matches
 * carry them. Nothing to show yet: renders nothing.
 */
function PlayerStatsSlot(_: { playerId: string; matches: MMatch[] }) {
  return null;
}

function PlayerScreen({ id, slug }: { id: string; slug: string }) {
  const { t } = useTheme();
  const tr = useT();
  const b = useBundle(slug);
  const l = useLive(slug, 10_000);
  const following = useFollowing("player", id);
  // A player looking at their own page sees their own photo, whatever the event shows everyone else.
  const me = useMyPlayer().data;
  const own = Boolean(me?.entries.some((e) => e.playerId === id));
  const v = useMemo(() => (b.data ? makeView(b.data, l.data) : null), [b.data, l.data]);
  const p = v?.player(id);
  if (!v || !p || !b.data) {
    // Still loading, or nothing to show (an old link, or a player no longer in the tournament).
    const notFound = <Empty title={tr("screens.playerNotFound")} body={tr("screens.playerNotFoundBody")} />;
    // A saved bundle can predate the player: only a fresh one can say they are not in it.
    const missing = !slug || Boolean(b.data && !p && b.dataUpdatedAt > 0);
    return (
      <Screen tabs={false} onRefresh={slug ? () => Promise.all([b.refetch(), l.refetch()]) : undefined}>
        <BackHeader label={tr("screens.playersBack")} fallback="/players" />
        {/* No bundle, or a saved one without this player: either way nothing to show until the server answers. */}
        {missing ? notFound : <LoadState queries={[{ ...b, data: undefined }]} what={tr("screens.whatPlayer")} notFound={notFound} />}
      </Screen>
    );
  }
  const tour = b.data.tournament;
  const ms = (l.data?.matches ?? []).filter((m) => playerSide(m, id, p.teamId) !== null);
  const done = ms.filter((m) => isDoneStatus(m.status));
  const rec = playerRecord(ms, id, p.teamId);
  const next = ms.filter((m) => !isDoneStatus(m.status) && m.status !== "cancelled").sort((a, c) => (a.scheduledTime ?? "9").localeCompare(c.scheduledTime ?? "9"));
  const nextWithDay = needsDay(next.slice(0, 3).filter((m) => !isOnCourt(m)).map((m) => m.scheduledTime), tour.timezone);
  const photoUrl = own && me?.photoUrl ? me.photoUrl : p.photoUrl;
  const facts = [
    typeof p.itfRank === "number" ? { label: tr("screens.itfJunior", { n: p.itfRank }), a11y: tr("screens.itfJuniorA11y", { n: p.itfRank }) } : null,
    typeof p.age === "number" ? { label: tr("screens.age", { n: p.age }), a11y: tr("screens.ageA11y", { n: p.age }) } : null,
  ].filter((x): x is { label: string; a11y: string } => Boolean(x));
  const firstName = p.name.split(/\s+/)[0] ?? p.name;

  return (
    <Screen tabs={false} onRefresh={() => Promise.all([b.refetch(), l.refetch()])}>
      <BackHeader label={tr("screens.playersBack")} fallback="/players" />
      <StaleBanner queries={[l]} live />

      <Card style={{ marginTop: 4, gap: 14, padding: 18 }}>
        <View style={{ flexDirection: "row", gap: 16, alignItems: "center" }}>
          <Portrait name={p.name} photoUrl={photoUrl} focalX={own ? undefined : p.focalX} focalY={own ? undefined : p.focalY} iso2={p.team.iso2} code={p.team.code} size={84} />
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
            <Display size={24}>{p.name}</Display>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Flag iso2={p.team.iso2} code={p.team.code} size={20} />
              <Body tone="ink2" size={13.5} numberOfLines={1} style={{ flexShrink: 1 }}>{p.team.name}</Body>
            </View>
          </View>
        </View>
        {facts.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {facts.map((f) => (
              <View key={f.label} accessibilityLabel={f.a11y}>
                <Chip label={f.label} />
              </View>
            ))}
          </View>
        )}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <LinkChip
            label={p.team.name}
            accessibilityLabel={tr(isNation(p.team, tour.isTies) ? "screens.pageNation" : "screens.pageTeam", { name: p.team.name })}
            onPress={() => openTeam(p.team, slug, tour.isTies)}
            leading={<Flag iso2={p.team.iso2} code={p.team.code} size={18} />}
          />
          <LinkChip label={tour.name} accessibilityLabel={tr("screens.pageTournament", { name: tour.name })} onPress={() => openTournament(slug)} />
        </View>
      </Card>

      <Card style={{ marginTop: 12, gap: 10, borderColor: following ? t.ball : t.line, borderWidth: following ? 1.5 : 1 }}>
        <Body weight="bold" size={16}>{following ? tr("screens.youFollowName", { name: firstName }) : tr("screens.followName", { name: firstName })}</Body>
        <Body tone="ink2" size={13}>
          {following ? tr("screens.playerAlertsOn", { name: firstName }) : tr("screens.playerAlertsOff", { name: firstName })}
        </Body>
        <Button kind={following ? "ghost" : "primary"} label={following ? tr("screens.followingBtn") : tr("screens.followFirst", { name: firstName })} onPress={() => void toggleFollow("player", id, tour.id)} />
      </Card>

      <SectionHeader title={tr("screens.atThisEvent")} />
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Card style={{ flex: 1, gap: 2 }}>
          <Num size={26}>{String(done.length)}</Num>
          <Eyebrow size={10} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{tr("screens.played")}</Eyebrow>
        </Card>
        <RecordCard label={tr("screens.wonLost")} rec={rec.all} />
        <RecordCard label={tr("screens.sets")} rec={rec.sets} />
      </View>
      {tour.isTies && (
        <View style={{ flexDirection: "row", gap: 12, marginTop: 12 }}>
          <RecordCard label={tr("screens.singles")} rec={rec.singles} />
          <RecordCard label={tr("screens.doubles")} rec={rec.doubles} />
        </View>
      )}
      <PlayerStatsSlot playerId={id} matches={done} />

      {next.length > 0 && <SectionHeader title={isOnCourt(next[0]!) ? tr("screens.onCourtNow") : tr("screens.nextMatch")} />}
      <View style={{ gap: 12 }}>{next.slice(0, 3).map((m) => <MatchMini key={m.id} m={m} v={v} withDay={nextWithDay} />)}</View>
      <SectionHeader title={tr("screens.results")} />
      {done.length > 0 ? (
        <View style={{ gap: 12 }}>{done.map((m) => <MatchMini key={m.id} m={m} v={v} />)}</View>
      ) : (
        <Body tone="ink2" size={13}>{tr("screens.resultsEmpty", { name: firstName })}</Body>
      )}
    </Screen>
  );
}

export default function PlayerRoute() {
  const { id, slug } = useLocalSearchParams<{ id: string; slug: string }>();
  const b = useBundle(slug);
  return (
    <SkinScope skin={b.data?.tournament.skin}>
      <PlayerScreen id={id} slug={slug} />
    </SkinScope>
  );
}
