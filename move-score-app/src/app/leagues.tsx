import { useState } from "react";
import { View } from "react-native";
import { monthLabel, shiftMonth } from "@core";
import { useMyLeagues, useTopBoard } from "../api/queries";
import { session } from "../state/session";
import { Screen } from "../ui/Screen";
import { BackHeader } from "../ui/Header";
import { Body, Display, Num } from "../ui/Text";
import { Card, Chip, LinkChip, SectionHeader } from "../ui/Bits";
import { LoadState } from "../ui/LoadState";
import { BoardTable } from "../ui/Board";
import { openLeague } from "../nav/links";

const STATUS_CHIP = { active: "Member", pending: "Waiting", awaiting_payment: "Payment due", removed: "Removed" } as const;

/**
 * Leagues: the account's own leagues (rank this month in each) and the top of
 * all leagues across Move Score, month by month. Organisations that opted out
 * are not on it.
 */
export default function Leagues() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const top = useTopBoard(month);
  const user = session.use((s) => s.user);
  const my = useMyLeagues(Boolean(user));
  const shown = top.data?.month;
  return (
    <Screen tabs={false} onRefresh={() => Promise.all([top.refetch(), user ? my.refetch() : Promise.resolve()])}>
      <BackHeader label="Back" />
      <Display size={26}>Leagues</Display>

      {user && (my.data?.leagues.length ?? 0) > 0 && <SectionHeader title="My leagues" />}
      <View style={{ gap: 8 }}>
        {my.data?.leagues.map((l) => (
          <Card key={l.slug} onPress={() => openLeague(l.slug)} accessibilityLabel={[l.name, l.organization?.name, l.rank ? `rank ${l.rank}` : null].filter(Boolean).join(". ")} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Chip label={STATUS_CHIP[l.status]} style={{ alignSelf: "flex-start" }} />
              <Body weight="bold" size={15} numberOfLines={1}>{l.name}</Body>
              <Body tone="ink2" size={12.5}>{[l.organization?.name, l.division].filter(Boolean).join(" · ")}</Body>
            </View>
            {l.status === "active" ? (
              <View style={{ alignItems: "flex-end" }}>
                <Num size={20}>{l.rank ? `#${l.rank}` : "—"}</Num>
                <Body tone="ink3" size={11.5}>{`${l.points} pts`}</Body>
              </View>
            ) : null}
          </Card>
        ))}
      </View>
      {user && my.data && !my.data.profileLinked ? (
        <Body tone="ink3" size={12.5} style={{ marginTop: 8 }}>Link your player profile (Account → player code) to join leagues.</Body>
      ) : null}

      <SectionHeader title="Top of all leagues" />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <LinkChip label="‹ Earlier" onPress={() => shown && setMonth(shiftMonth(shown, -1))} accessibilityLabel="Previous month" />
        <Body weight="semi" size={13}>{shown ? monthLabel(shown) : ""}</Body>
        <LinkChip label="Later ›" onPress={() => shown && setMonth(shiftMonth(shown, 1))} accessibilityLabel="Next month" />
      </View>
      {top.data ? <BoardTable lines={top.data.lines} empty="No league results this month yet." /> : <LoadState queries={[top]} what="the top board" compact />}
      <Body tone="ink3" size={12} style={{ marginTop: 8 }}>Total league points this month across every club on Move Score that takes part.</Body>
    </Screen>
  );
}
