import { useState } from "react";
import { View } from "react-native";
import { router, type Href } from "expo-router";
import { displayPhone, type MMyProfile } from "@core";
import { errorMessage } from "../api/client";
import { session } from "../state/session";
import { useTheme } from "../theme/ThemeProvider";
import { shareWithOrganization, useMyProfile } from "../player/me";
import { MyMatchRow, PlayerAvatar } from "../player/ui";
import { LoadState } from "../ui/LoadState";
import { openRegistrations } from "../nav/links";
import { Screen } from "../ui/Screen";
import { BackHeader } from "../ui/Header";
import { Body, Display, Eyebrow, Num } from "../ui/Text";
import { Button, Card, Chip, SectionHeader } from "../ui/Bits";
import { useT } from "../i18n";
import { fmt } from "../i18n/t";

const day = (iso: string) => fmt().date(iso);

/**
 * My profile: the signed-in player's own history from GET /me/profile:
 * tournaments, sessions and nights, results and what is coming up. Leagues,
 * league points and ranks arrive with leagues; until then this says so, with no
 * sample numbers. Organisations that only matched the player by a number typed on
 * their form can be shown the player's details from here.
 */
export default function MyProfile() {
  const tr = useT();
  const user = session.use((s) => s.user);
  const q = useMyProfile();
  if (!user) {
    return (
      <Screen tabs={false}>
        <BackHeader label={tr("ui.account")} fallback="/account" />
        <Display size={28}>{tr("player.myProfile")}</Display>
        <Card style={{ marginTop: 16, gap: 10 }}>
          <Body tone="ink2">{tr("player.signInProfile")}</Body>
          <Button kind="ghost" label={tr("auth.backToAccount")} onPress={() => router.replace("/account")} />
        </Card>
      </Screen>
    );
  }
  return (
    <Screen tabs={false} onRefresh={() => q.refetch()}>
      <BackHeader label={tr("ui.account")} fallback="/account" />
      {q.data ? <Profile p={q.data} /> : <LoadState queries={[q]} what={tr("player.yourProfile")} />}
    </Screen>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <View style={{ flex: 1, alignItems: "center", gap: 2 }}>
      <Num size={22}>{value}</Num>
      <Body tone="ink3" size={11.5}>{label}</Body>
    </View>
  );
}

function Profile({ p }: { p: MMyProfile }) {
  const { t } = useTheme();
  const tr = useT();
  const [sharing, setSharing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tz = "Africa/Cairo";

  if (!p.linked) {
    return (
      <>
        <Display size={28}>{tr("player.myProfile")}</Display>
        <Card style={{ marginTop: 16, gap: 10 }}>
          <Body weight="semi">{tr("player.linkYourHistory")}</Body>
          <Body tone="ink2" size={13}>{tr("player.linkHistoryBody")}</Body>
          <Button label={tr("player.enterPlayerCode")} onPress={() => router.push("/player-code")} />
          <Button kind="ghost" label={tr("player.useMyPhone")} onPress={() => router.push("/link-phone" as Href)} />
        </Card>
      </>
    );
  }

  return (
    <>
      <View style={{ alignItems: "center", gap: 10 }}>
        <PlayerAvatar player={{ name: p.name ?? "?", photoUrl: p.photoUrl }} size={88} />
        <Display size={28} style={{ textAlign: "center" }}>{p.name ?? tr("player.myProfile")}</Display>
        {p.phone ? (
          <Body tone="ink2" size={13}>{p.phoneVerified ? tr("player.phoneConfirmed", { phone: displayPhone(p.phone) }) : displayPhone(p.phone)}</Body>
        ) : null}
      </View>

      <Card style={{ marginTop: 14, flexDirection: "row" }}>
        <Stat value={p.totals.tournaments} label={tr("player.statTournaments")} />
        <Stat value={p.totals.sessions} label={tr("player.statSessions")} />
        <Stat value={p.totals.played} label={tr("player.statPlayed")} />
        <Stat value={p.totals.won} label={tr("player.statWon")} />
      </Card>

      {p.upcoming.length > 0 && (
        <>
          <SectionHeader title={tr("player.comingUp")} />
          <View style={{ gap: 8 }}>
            {p.upcoming.slice(0, 5).map((m) => (
              <MyMatchRow key={m.id} m={m} timezone={tz} />
            ))}
          </View>
        </>
      )}

      <SectionHeader title={tr("player.statTournaments")} />
      {p.tournaments.length === 0 ? (
        <Body tone="ink2" size={13}>{tr("player.noTournaments")}</Body>
      ) : (
        <View style={{ gap: 8 }}>
          {p.tournaments.map((x) => (
            <Card key={x.tournamentId} onPress={() => router.push({ pathname: "/t/[slug]", params: { slug: x.slug } })} style={{ gap: 4 }}>
              <Body weight="semi">{x.name}</Body>
              <Body tone="ink2" size={12.5}>{[x.organization?.name, x.teamName, x.played ? tr("player.wonOf", { won: x.won, played: x.played }) : null].filter(Boolean).join(" · ")}</Body>
            </Card>
          ))}
        </View>
      )}

      <SectionHeader title={tr("player.sessionsNights")} />
      {p.sessions.length === 0 ? (
        <Body tone="ink2" size={13}>{tr("player.noSessions")}</Body>
      ) : (
        <View style={{ gap: 8 }}>
          {p.sessions.map((s) => (
            <Card key={s.sessionId} style={{ gap: 4 }}>
              <Body weight="semi">{s.name}</Body>
              <Body tone="ink2" size={12.5}>{[day(s.date), s.organization?.name, tr("player.nPlayed", { n: s.played }), tr("player.nPts", { n: s.points })].filter(Boolean).join(" · ")}</Body>
            </Card>
          ))}
        </View>
      )}

      {p.results.length > 0 && (
        <>
          <SectionHeader title={tr("player.results")} />
          <View style={{ gap: 8 }}>
            {p.results.slice(0, 10).map((m) => (
              <MyMatchRow key={m.id} m={m} timezone={tz} />
            ))}
          </View>
        </>
      )}

      <SectionHeader title={tr("account.registrations")} />
      <Card onPress={openRegistrations} accessibilityLabel={tr("player.myRegistrationsA11y")} style={{ gap: 4 }}>
        <Body weight="semi">{tr("account.myRegistrations")}</Body>
        <Body tone="ink2" size={12.5}>{tr("player.myRegistrationsHint")}</Body>
      </Card>

      <SectionHeader title={tr("player.leaguesRanks")} />
      <Card style={{ gap: 6 }}>
        <Chip label={tr("player.comingSoon")} />
        <Body tone="ink2" size={13}>{tr("player.leaguesSoon")}</Body>
      </Card>

      {p.organizations.length > 0 && (
        <>
          <SectionHeader title={tr("player.organisations")} />
          <View style={{ gap: 8 }}>
            {p.organizations.map((o) => (
              <Card key={o.id} style={{ gap: 6 }}>
                <Body weight="semi" onPress={() => router.push({ pathname: "/org/[slug]", params: { slug: o.slug } })}>{o.name}</Body>
                {o.sharing ? (
                  <Body tone="ink2" size={12.5}>{tr("player.seesContact")}</Body>
                ) : o.canShare ? (
                  <>
                    <Body tone="ink2" size={12.5}>{tr("player.shareQ", { org: o.name })}</Body>
                    <Button
                      kind="ghost"
                      label={sharing === o.id ? tr("player.sharing") : tr("player.shareDetails")}
                      disabled={sharing !== null}
                      onPress={() => {
                        setSharing(o.id);
                        setErr(null);
                        void shareWithOrganization(o.id)
                          .catch((e) => setErr(errorMessage(e)))
                          .finally(() => setSharing(null));
                      }}
                    />
                  </>
                ) : (
                  <Body tone="ink2" size={12.5}>{tr("player.notSeesContact")}</Body>
                )}
              </Card>
            ))}
          </View>
        </>
      )}
      {err ? <Body tone="live" size={13} style={{ marginTop: 8 }}>{err}</Body> : null}

      <SectionHeader title={tr("player.missing")} />
      <Card style={{ gap: 8, borderColor: t.line }}>
        <Body tone="ink2" size={13}>{tr("player.missingBody")}</Body>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button kind="ghost" label={tr("player.playerCode")} onPress={() => router.push("/player-code")} style={{ flex: 1 }} />
          <Button kind="ghost" label={tr("player.phoneNumber")} onPress={() => router.push("/link-phone" as Href)} style={{ flex: 1 }} />
        </View>
      </Card>
    </>
  );
}
