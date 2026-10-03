import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useBundle } from "../../api/queries";
import { SkinScope } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Empty, Flag } from "../../ui/Bits";
import { OfflineState, failedOffline } from "../../ui/Offline";
import { TeamSection } from "../../ui/TeamSection";

/** A team of a club event (not a nation): its matches and players in that tournament. */
export default function TeamScreen() {
  const { id, slug } = useLocalSearchParams<{ id: string; slug: string }>();
  const b = useBundle(slug);
  const team = b.data?.teams.find((x) => x.id === id);
  if (!b.data || !team) {
    return (
      <Screen tabs={false}>
        <BackHeader label="Back" fallback={slug ? { pathname: "/t/[slug]", params: { slug } } : "/"} />
        {slug && !b.data && failedOffline(b) ? (
          <OfflineState what="this team" onRetry={() => b.refetch()} />
        ) : !slug || b.isError || b.data ? (
          <Empty title="Team not found" body="Open the team again from the tournament page." />
        ) : (
          <Body tone="ink2">Loading…</Body>
        )}
      </Screen>
    );
  }
  return (
    <SkinScope skin={b.data.tournament.skin}>
      <Screen tabs={false} onRefresh={() => b.refetch()}>
        <BackHeader label="Back" fallback={{ pathname: "/t/[slug]", params: { slug } }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, marginTop: 4 }}>
          {team.iso2 ? <Flag iso2={team.iso2} code={team.code} size={48} /> : null}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Eyebrow>{[team.code, team.seed ? `Seed ${team.seed}` : null].filter(Boolean).join(" · ")}</Eyebrow>
            <Display size={24} style={{ marginTop: 4 }}>{team.name}</Display>
          </View>
        </View>
        <TeamSection slug={slug} pick={(x) => x.id === id} />
      </Screen>
    </SkinScope>
  );
}
