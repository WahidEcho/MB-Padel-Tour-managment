import { useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { LEAGUE_VISIBILITY_BADGE, leagueVisibility, monthLabel, shiftMonth } from "@core";
import { ApiError } from "../api/client";
import { revealLeague, useMyLeagues, useTopBoard } from "../api/queries";
import { useTheme } from "../theme/ThemeProvider";
import { session } from "../state/session";
import { Screen } from "../ui/Screen";
import { BackHeader } from "../ui/Header";
import { Body, Display, Num } from "../ui/Text";
import { Button, Card, Chip, LinkChip, SectionHeader } from "../ui/Bits";
import { LoadState } from "../ui/LoadState";
import { BoardTable, LeagueLine, VisibilityBadge } from "../ui/Board";
import { openLeague } from "../nav/links";

const STATUS_CHIP = { active: "Member", pending: "Waiting", awaiting_payment: "Payment due", removed: "Removed" } as const;

/**
 * Entering a league's invite code: the league opens for this account (an "Invite
 * only" league included) and its page opens.
 */
function InviteCodeCard() {
  const { t } = useTheme();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const l = await revealLeague(code.trim());
      setCode("");
      openLeague(l.slug);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Can't reach Move Score right now.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card style={{ gap: 10 }}>
      <Body weight="semi">Have an invite code?</Body>
      <Body tone="ink2" size={12.5}>Some leagues are invite only. Enter the code the organiser gave you to see the league and join it.</Body>
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
        accessibilityLabel="League invite code"
        style={{ backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, color: t.ink, fontSize: 20, letterSpacing: 4, textAlign: "center" }}
      />
      <Button label={busy ? "Opening…" : "Open the league"} disabled={busy || code.replace(/[^0-9a-z]/gi, "").length < 8} onPress={() => void go()} />
      {msg ? <Body tone="live" size={13} accessibilityLiveRegion="polite">{msg}</Body> : null}
    </Card>
  );
}

/**
 * Leagues: the account's own leagues (rank this month in each), the leagues only
 * some people can see that this account can ("Members only" / "Invite only"), an
 * invite code to open one, and the top of all leagues across Move Score, month by
 * month. Organisations that opted out, and leagues that are not public, are not on it.
 */
export default function Leagues() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const top = useTopBoard(month);
  const user = session.use((s) => s.user);
  const my = useMyLeagues(Boolean(user));
  const shown = top.data?.month;
  // Leagues only some people see, that this account can (not already in its own list).
  const forYou = user ? (my.data?.visible ?? []).filter((v) => !my.data?.leagues.some((m) => m.slug === v.slug)) : [];
  return (
    <Screen tabs={false} onRefresh={() => Promise.all([top.refetch(), user ? my.refetch() : Promise.resolve()])}>
      <BackHeader label="Back" />
      <Display size={26}>Leagues</Display>

      {user && (my.data?.leagues.length ?? 0) > 0 && <SectionHeader title="My leagues" />}
      <View style={{ gap: 8 }}>
        {my.data?.leagues.map((l) => (
          <Card key={l.slug} onPress={() => openLeague(l.slug)} accessibilityLabel={[l.name, LEAGUE_VISIBILITY_BADGE[leagueVisibility(l.visibility)], l.organization?.name, l.rank ? `rank ${l.rank}` : null].filter(Boolean).join(". ")} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <View style={{ flexDirection: "row", gap: 6 }}>
                <Chip label={STATUS_CHIP[l.status]} />
                {LEAGUE_VISIBILITY_BADGE[leagueVisibility(l.visibility)] ? <VisibilityBadge label={LEAGUE_VISIBILITY_BADGE[leagueVisibility(l.visibility)]!} /> : null}
              </View>
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

      {forYou.length > 0 && <SectionHeader title="Leagues for you" />}
      <View style={{ gap: 8 }}>
        {forYou.map((l) => <LeagueLine key={l.slug} l={l} showOrg />)}
      </View>
      {user ? (
        <View style={{ marginTop: 16 }}>
          <InviteCodeCard />
        </View>
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
