import { useCallback, useState } from "react";
import { TextInput, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { session, saveStaff } from "../../state/session";
import { pendingCode, pruneCarry, signInWithCode, signOutReferee } from "../../referee/courtSignIn";
import { queue } from "../../referee/queue";
import { AssistanceCard } from "../../referee/AssistanceCard";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card, Chip, Empty, SectionHeader } from "../../ui/Bits";
import { LoadState } from "../../ui/LoadState";
import { useT } from "../../i18n";
import { roleLabel, tournamentStatusLabel } from "../../referee/words";

interface T {
  id: string;
  name: string;
  sport: string;
  status: string;
  is_demo: boolean;
}

export default function RefereeHome() {
  const { t } = useTheme();
  const tr = useT();
  const staff = session.use((s) => s.staff);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingMatches, setPendingMatches] = useState<string[]>([]);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const carries = session.use((s) => s.staffCarry);
  // Looked at again on every visit: a match opened from here may have sent its points meanwhile.
  useFocusEffect(
    useCallback(() => {
      void queue().matchesWithPending().then(setPendingMatches);
      void pruneCarry();
    }, []),
  );
  const list = useQuery({
    queryKey: ["ref-tournaments", staff?.token],
    queryFn: () => api<{ tournaments: T[]; court?: { name: string } | null }>("/api/mobile/v1/referee/tournaments", { who: "staff" }),
    enabled: Boolean(staff),
  });
  const court = list.data?.court?.name ?? null;
  const signIn = async () => {
    setBusy(true);
    setErr(null);
    const typed = code.trim();
    const r = await signInWithCode(typed);
    setBusy(false);
    if (r.ok) {
      setCode("");
      if (r.master) router.push("/referee/master");
      return;
    }
    if (r.pinRequired) {
      // A court (or master) code: the PIN next, the code kept in memory only.
      pendingCode.set(typed, r.court ?? null, Boolean(r.master), r.referees ?? []);
      setCode("");
      router.push("/referee/pin");
      return;
    }
    setErr(r.message);
  };
  return (
    <Screen tabs={false} onRefresh={staff ? () => list.refetch() : undefined}>
      <BackHeader label={tr("common.back")} />
      <Eyebrow tone="live">{tr("referee.eyebrow")}</Eyebrow>
      <Display size={30} style={{ marginTop: 6 }}>{tr("referee.courtReady")}</Display>
      {pendingMatches.length > 0 && (
        <Card style={{ marginTop: 14, gap: 8, borderColor: t.warning, borderWidth: 1 }}>
          <Body weight="semi">{tr("referee.pendingTitle")}</Body>
          <Body tone="ink2" size={13}>{tr("referee.pendingBody")}</Body>
          {pendingMatches.map((id) => (
            <Button key={id} kind="ghost" label={tr("referee.openThatMatch")} onPress={() => router.push({ pathname: "/referee/score/[matchId]", params: { matchId: id } })} />
          ))}
        </Card>
      )}
      {!staff ? (
        <Card style={{ marginTop: 16, gap: 12 }}>
          <Chip label={tr("referee.modeChip")} ball />
          <Body weight="semi">{tr("referee.accessCode")}</Body>
          <TextInput
            value={code}
            onChangeText={setCode}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={tr("referee.codePlaceholder")}
            placeholderTextColor={t.ink3}
            accessibilityLabel={tr("referee.codeA11y")}
            onSubmitEditing={() => void signIn()}
            style={{ backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 14, color: t.ink, fontSize: 18 }}
          />
          {err ? <Body tone="live" size={13}>{err}</Body> : null}
          <Button label={busy ? tr("referee.checking") : tr("referee.openConsole")} disabled={!code || busy} onPress={() => void signIn()} />
          <Button kind="ghost" label={tr("referee.scanCourtQr")} onPress={() => router.push("/referee/scan")} />
          <Body tone="ink3" size={12}>{tr("referee.offlineNote")}</Body>
        </Card>
      ) : (
        <>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
            <Body tone="ink2" size={13}>
              {staff.referee ? `${staff.referee.name} · ` : ""}
              {court ? tr("referee.signedInCourt", { court }) : staff.referee?.role === "master_referee" ? tr("referee.masterReferee") : tr("referee.signedInRole", { role: roleLabel(staff.role) })}
            </Body>
            <Body tone="blue" weight="semi" size={13} onPress={() => (pendingMatches.length ? setConfirmSignOut(true) : void signOutReferee())}>{tr("referee.signOut")}</Body>
          </View>
          {confirmSignOut && (
            <Card style={{ marginTop: 10, gap: 8, borderColor: t.live, borderWidth: 1 }}>
              <Body weight="semi">{tr("referee.unsentWarning", { count: pendingMatches.length })}</Body>
              <Body tone="ink2" size={13}>{tr("referee.unsentBody")}</Body>
              <Button kind="danger" label={tr("referee.signOutAnyway")} onPress={() => { setConfirmSignOut(false); void signOutReferee(); }} />
              <Button kind="ghost" label={tr("referee.staySignedIn")} onPress={() => setConfirmSignOut(false)} />
            </Card>
          )}
          {/* The console's actions, one group with even spacing (they used to touch each other). */}
          <View style={{ marginTop: 16, gap: 12 }}>
            {staff.referee?.role === "master_referee" && (
              <Button label={tr("referee.masterButton")} onPress={() => router.push("/referee/master")} />
            )}
            {court && staff.referee && <AssistanceCard />}
            <Button kind="ghost" label={tr("referee.scanSwitch")} onPress={() => router.push("/referee/scan")} />
          </View>
          {carries.flatMap((c) => c.matchIds.map((id) => ({ id, court: c.court }))).length > 0 && (
            <Card style={{ marginTop: 10, gap: 8 }}>
              <Body weight="semi">{tr("referee.carryTitle")}</Body>
              <Body tone="ink2" size={13}>{tr("referee.carryBody")}</Body>
              {carries.flatMap((c) => c.matchIds.map((id) => ({ id, court: c.court }))).map((x) => (
                <Button key={x.id} kind="ghost" label={x.court ? tr("referee.openCourtMatch", { court: x.court }) : tr("referee.openEarlierMatch")} onPress={() => router.push({ pathname: "/referee/score/[matchId]", params: { matchId: x.id } })} />
              ))}
            </Card>
          )}
          <SectionHeader title={court ? tr("referee.courtToday", { court }) : tr("referee.whatScoring")} />
          <View style={{ gap: 8 }}>
            {list.data?.tournaments.map((x) => (
              <Card key={x.id} onPress={() => router.push({ pathname: "/referee/[tournamentId]", params: { tournamentId: x.id } })} style={{ gap: 4 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Chip label={tournamentStatusLabel(x.status)} />
                  <Eyebrow size={10}>{x.is_demo ? tr("referee.demoTag", { sport: x.sport }) : x.sport}</Eyebrow>
                </View>
                <Body weight="bold" size={16}>{x.name}</Body>
              </Card>
            ))}
            {!list.data && <LoadState compact queries={[list]} what={tr("referee.whatTournaments")} />}
            {list.data && !list.data.tournaments.length && <Empty title={tr("referee.noTournaments")} body={tr("referee.noTournamentsBody")} />}
          </View>
        </>
      )}
    </Screen>
  );
}
