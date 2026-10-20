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

interface T {
  id: string;
  name: string;
  sport: string;
  status: string;
  is_demo: boolean;
}

export default function RefereeHome() {
  const { t } = useTheme();
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
      <BackHeader label="Back" />
      <Eyebrow tone="live">Move Score · Referee</Eyebrow>
      <Display size={30} style={{ marginTop: 6 }}>Court-ready</Display>
      {pendingMatches.length > 0 && (
        <Card style={{ marginTop: 14, gap: 8, borderColor: t.warning, borderWidth: 1 }}>
          <Body weight="semi">Points waiting to send</Body>
          <Body tone="ink2" size={13}>This phone has scored points that have not reached the server yet. Open the match to send them.</Body>
          {pendingMatches.map((id) => (
            <Button key={id} kind="ghost" label="Open that match" onPress={() => router.push({ pathname: "/referee/score/[matchId]", params: { matchId: id } })} />
          ))}
        </Card>
      )}
      {!staff ? (
        <Card style={{ marginTop: 16, gap: 12 }}>
          <Chip label="Referee mode" ball />
          <Body weight="semi">Access code</Body>
          <TextInput
            value={code}
            onChangeText={setCode}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Court code or code from the desk"
            placeholderTextColor={t.ink3}
            accessibilityLabel="Referee access code"
            onSubmitEditing={() => void signIn()}
            style={{ backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 14, color: t.ink, fontSize: 18 }}
          />
          {err ? <Body tone="live" size={13}>{err}</Body> : null}
          <Button label={busy ? "Checking…" : "Open referee console"} disabled={!code || busy} onPress={() => void signIn()} />
          <Button kind="ghost" label="Scan court QR" onPress={() => router.push("/referee/scan")} />
          <Body tone="ink3" size={12}>Once a match is open, scoring continues without signal and sends when the connection returns.</Body>
        </Card>
      ) : (
        <>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
            <Body tone="ink2" size={13}>
              {staff.referee ? `${staff.referee.name} · ` : ""}
              {court ? `Signed in · ${court}` : staff.referee?.role === "master_referee" ? "Master referee" : `Signed in · ${staff.role}`}
            </Body>
            <Body tone="blue" weight="semi" size={13} onPress={() => (pendingMatches.length ? setConfirmSignOut(true) : void signOutReferee())}>Sign out</Body>
          </View>
          {confirmSignOut && (
            <Card style={{ marginTop: 10, gap: 8, borderColor: t.live, borderWidth: 1 }}>
              <Body weight="semi">{`Points from ${pendingMatches.length === 1 ? "a match" : `${pendingMatches.length} matches`} have not reached the server yet.`}</Body>
              <Body tone="ink2" size={13}>Signed out, this phone cannot send them. They stay on the phone and send after the next sign-in.</Body>
              <Button kind="danger" label="Sign out anyway" onPress={() => { setConfirmSignOut(false); void signOutReferee(); }} />
              <Button kind="ghost" label="Stay signed in" onPress={() => setConfirmSignOut(false)} />
            </Card>
          )}
          {staff.referee?.role === "master_referee" && (
            <Button label="Calls for assistance & courts" onPress={() => router.push("/referee/master")} />
          )}
          {court && staff.referee && (
            <View style={{ marginTop: 10 }}>
              <AssistanceCard />
            </View>
          )}
          <Button kind="ghost" label="Scan court QR (switch court)" onPress={() => router.push("/referee/scan")} />
          {carries.flatMap((c) => c.matchIds.map((id) => ({ id, court: c.court }))).length > 0 && (
            <Card style={{ marginTop: 10, gap: 8 }}>
              <Body weight="semi">Still yours from your last court</Body>
              <Body tone="ink2" size={13}>Finish these and send their points: the old court&apos;s access ends for each once it is sent and finished.</Body>
              {carries.flatMap((c) => c.matchIds.map((id) => ({ id, court: c.court }))).map((x) => (
                <Button key={x.id} kind="ghost" label={`Open the ${x.court ?? "earlier"} match`} onPress={() => router.push({ pathname: "/referee/score/[matchId]", params: { matchId: x.id } })} />
              ))}
            </Card>
          )}
          <SectionHeader title={court ? `${court}: today's matches` : "What are you scoring?"} />
          <View style={{ gap: 8 }}>
            {list.data?.tournaments.map((x) => (
              <Card key={x.id} onPress={() => router.push({ pathname: "/referee/[tournamentId]", params: { tournamentId: x.id } })} style={{ gap: 4 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Chip label={x.status} />
                  <Eyebrow size={10}>{x.is_demo ? `${x.sport} · demo` : x.sport}</Eyebrow>
                </View>
                <Body weight="bold" size={16}>{x.name}</Body>
              </Card>
            ))}
            {!list.data && <LoadState compact queries={[list]} what="the tournaments" />}
            {list.data && !list.data.tournaments.length && <Empty title="No tournaments to score" body="The tournament desk has not opened one for referees yet." />}
          </View>
        </>
      )}
    </Screen>
  );
}
