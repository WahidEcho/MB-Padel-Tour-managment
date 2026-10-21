import { useState } from "react";
import { Platform, TextInput, View } from "react-native";
import { leagueVisibility, shiftMonth } from "@core";
import { leagueBadge, monthName } from "../api/model";
import { tr as trNow, useT } from "../i18n";
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

const statusChip = (s: "active" | "pending" | "awaiting_payment" | "removed") =>
  trNow(s === "active" ? "screens.chipMember" : s === "pending" ? "screens.chipWaiting" : s === "awaiting_payment" ? "screens.chipPaymentDue" : "screens.chipRemoved");

/**
 * Entering a league's invite code: the league opens for this account (an "Invite
 * only" league included) and its page opens.
 */
function InviteCodeCard() {
  const { t } = useTheme();
  const tr = useT();
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
      setMsg(e instanceof ApiError ? e.message : tr("screens.cantReach"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card style={{ gap: 10 }}>
      <Body weight="semi">{tr("screens.haveInvite")}</Body>
      <Body tone="ink2" size={12.5}>{tr("screens.inviteBody")}</Body>
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
        accessibilityLabel={tr("screens.inviteA11y")}
        style={{ backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, color: t.ink, fontSize: 20, letterSpacing: 4, textAlign: "center" }}
      />
      <Button label={busy ? tr("screens.opening") : tr("screens.openLeague")} disabled={busy || code.replace(/[^0-9a-z]/gi, "").length < 8} onPress={() => void go()} />
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
  const tr = useT();
  const [month, setMonth] = useState<string | undefined>(undefined);
  const top = useTopBoard(month);
  const user = session.use((s) => s.user);
  const my = useMyLeagues(Boolean(user));
  const shown = top.data?.month;
  // Leagues only some people see, that this account can (not already in its own list).
  const forYou = user ? (my.data?.visible ?? []).filter((v) => !my.data?.leagues.some((m) => m.slug === v.slug)) : [];
  return (
    <Screen tabs={false} onRefresh={() => Promise.all([top.refetch(), user ? my.refetch() : Promise.resolve()])}>
      <BackHeader label={tr("common.back")} />
      <Display size={26}>{tr("screens.leaguesTitle")}</Display>

      {user && (my.data?.leagues.length ?? 0) > 0 && <SectionHeader title={tr("screens.myLeagues")} />}
      <View style={{ gap: 8 }}>
        {my.data?.leagues.map((l) => (
          <Card key={l.slug} onPress={() => openLeague(l.slug)} accessibilityLabel={[l.name, leagueBadge(leagueVisibility(l.visibility)), l.organization?.name, l.rank ? tr("screens.rankA11y", { n: l.rank }) : null].filter(Boolean).join(". ")} style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <View style={{ flexDirection: "row", gap: 6 }}>
                <Chip label={statusChip(l.status)} />
                {leagueBadge(leagueVisibility(l.visibility)) ? <VisibilityBadge label={leagueBadge(leagueVisibility(l.visibility))!} /> : null}
              </View>
              <Body weight="bold" size={15} numberOfLines={1}>{l.name}</Body>
              <Body tone="ink2" size={12.5}>{[l.organization?.name, l.division].filter(Boolean).join(" · ")}</Body>
            </View>
            {l.status === "active" ? (
              <View style={{ alignItems: "flex-end" }}>
                <Num size={20}>{l.rank ? `#${l.rank}` : "—"}</Num>
                <Body tone="ink3" size={11.5}>{tr("screens.pts", { n: l.points })}</Body>
              </View>
            ) : null}
          </Card>
        ))}
      </View>
      {user && my.data && !my.data.profileLinked ? (
        <Body tone="ink3" size={12.5} style={{ marginTop: 8 }}>{tr("screens.linkToJoin")}</Body>
      ) : null}

      {forYou.length > 0 && <SectionHeader title={tr("screens.leaguesForYou")} />}
      <View style={{ gap: 8 }}>
        {forYou.map((l) => <LeagueLine key={l.slug} l={l} showOrg />)}
      </View>
      {user ? (
        <View style={{ marginTop: 16 }}>
          <InviteCodeCard />
        </View>
      ) : null}

      <SectionHeader title={tr("screens.topLeagues")} />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <LinkChip label={tr("screens.earlier")} onPress={() => shown && setMonth(shiftMonth(shown, -1))} accessibilityLabel={tr("screens.prevMonthA11y")} />
        <Body weight="semi" size={13}>{shown ? monthName(shown) : ""}</Body>
        <LinkChip label={tr("screens.later")} onPress={() => shown && setMonth(shiftMonth(shown, 1))} accessibilityLabel={tr("screens.nextMonthA11y")} />
      </View>
      {top.data ? <BoardTable lines={top.data.lines} empty={tr("screens.noResultsMonth")} /> : <LoadState queries={[top]} what={tr("screens.whatTopBoard")} compact />}
      <Body tone="ink3" size={12} style={{ marginTop: 8 }}>{tr("screens.totalPoints")}</Body>
    </Screen>
  );
}
