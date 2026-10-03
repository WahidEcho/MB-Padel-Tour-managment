import { useCallback, useState } from "react";
import { TextInput, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import { session, saveStaff } from "../../state/session";
import { queue } from "../../referee/queue";
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
  // Looked at again on every visit: a match opened from here may have sent its points meanwhile.
  useFocusEffect(
    useCallback(() => {
      void queue().matchesWithPending().then(setPendingMatches);
    }, []),
  );
  const list = useQuery({ queryKey: ["ref-tournaments", staff?.token], queryFn: () => api<{ tournaments: T[] }>("/api/mobile/v1/referee/tournaments", { who: "staff" }), enabled: Boolean(staff) });
  const signIn = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ token: string; role: string; expiresAt: string }>("/api/mobile/v1/staff/session", { body: { code: code.trim() } });
      await saveStaff({ token: r.token, role: r.role, expiresAt: r.expiresAt });
      setCode("");
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "No connection. The code is checked online once; scoring then works offline.");
    } finally {
      setBusy(false);
    }
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
            placeholder="Code from the tournament desk"
            placeholderTextColor={t.ink3}
            accessibilityLabel="Referee access code"
            onSubmitEditing={() => void signIn()}
            style={{ backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 14, color: t.ink, fontSize: 18 }}
          />
          {err ? <Body tone="live" size={13}>{err}</Body> : null}
          <Button label={busy ? "Checking…" : "Open referee console"} disabled={!code || busy} onPress={() => void signIn()} />
          <Body tone="ink3" size={12}>Once a match is open, scoring continues without signal and sends when the connection returns.</Body>
        </Card>
      ) : (
        <>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
            <Body tone="ink2" size={13}>{`Signed in · ${staff.role}`}</Body>
            <Body tone="blue" weight="semi" size={13} onPress={() => (pendingMatches.length ? setConfirmSignOut(true) : void saveStaff(null))}>Sign out</Body>
          </View>
          {confirmSignOut && (
            <Card style={{ marginTop: 10, gap: 8, borderColor: t.live, borderWidth: 1 }}>
              <Body weight="semi">{`Points from ${pendingMatches.length === 1 ? "a match" : `${pendingMatches.length} matches`} have not reached the server yet.`}</Body>
              <Body tone="ink2" size={13}>Signed out, this phone cannot send them. They stay on the phone and send after the next sign-in.</Body>
              <Button kind="danger" label="Sign out anyway" onPress={() => { setConfirmSignOut(false); void saveStaff(null); }} />
              <Button kind="ghost" label="Stay signed in" onPress={() => setConfirmSignOut(false)} />
            </Card>
          )}
          <SectionHeader title="What are you scoring?" />
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
