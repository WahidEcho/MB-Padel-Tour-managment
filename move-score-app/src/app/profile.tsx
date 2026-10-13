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
import { Screen } from "../ui/Screen";
import { BackHeader } from "../ui/Header";
import { Body, Display, Eyebrow, Num } from "../ui/Text";
import { Button, Card, Chip, SectionHeader } from "../ui/Bits";

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/**
 * My profile: the signed-in player's own history from GET /me/profile:
 * tournaments, sessions and nights, results and what is coming up. Leagues,
 * league points and ranks arrive with leagues; until then this says so, with no
 * sample numbers. Organisations that only matched the player by a number typed on
 * their form can be shown the player's details from here.
 */
export default function MyProfile() {
  const user = session.use((s) => s.user);
  const q = useMyProfile();
  if (!user) {
    return (
      <Screen tabs={false}>
        <BackHeader label="Account" fallback="/account" />
        <Display size={28}>My profile</Display>
        <Card style={{ marginTop: 16, gap: 10 }}>
          <Body tone="ink2">Sign in to see your tournaments, sessions and results.</Body>
          <Button kind="ghost" label="Back to Account" onPress={() => router.replace("/account")} />
        </Card>
      </Screen>
    );
  }
  return (
    <Screen tabs={false} onRefresh={() => q.refetch()}>
      <BackHeader label="Account" fallback="/account" />
      {q.data ? <Profile p={q.data} /> : <LoadState queries={[q]} what="your profile" />}
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
  const [sharing, setSharing] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tz = "Africa/Cairo";

  if (!p.linked) {
    return (
      <>
        <Display size={28}>My profile</Display>
        <Card style={{ marginTop: 16, gap: 10 }}>
          <Body weight="semi">Link your history</Body>
          <Body tone="ink2" size={13}>Your tournaments, sessions and results appear here once your account is linked to your player entries.</Body>
          <Button label="Enter a player code" onPress={() => router.push("/player-code")} />
          <Button kind="ghost" label="Use my phone number" onPress={() => router.push("/link-phone" as Href)} />
        </Card>
      </>
    );
  }

  return (
    <>
      <View style={{ alignItems: "center", gap: 10 }}>
        <PlayerAvatar player={{ name: p.name ?? "?", photoUrl: p.photoUrl }} size={88} />
        <Display size={28} style={{ textAlign: "center" }}>{p.name ?? "My profile"}</Display>
        {p.phone ? (
          <Body tone="ink2" size={13}>{`${displayPhone(p.phone)}${p.phoneVerified ? " · confirmed" : ""}`}</Body>
        ) : null}
      </View>

      <Card style={{ marginTop: 14, flexDirection: "row" }}>
        <Stat value={p.totals.tournaments} label="Tournaments" />
        <Stat value={p.totals.sessions} label="Sessions" />
        <Stat value={p.totals.played} label="Played" />
        <Stat value={p.totals.won} label="Won" />
      </Card>

      {p.upcoming.length > 0 && (
        <>
          <SectionHeader title="Coming up" />
          <View style={{ gap: 8 }}>
            {p.upcoming.slice(0, 5).map((m) => (
              <MyMatchRow key={m.id} m={m} timezone={tz} />
            ))}
          </View>
        </>
      )}

      <SectionHeader title="Tournaments" />
      {p.tournaments.length === 0 ? (
        <Body tone="ink2" size={13}>No tournaments linked yet.</Body>
      ) : (
        <View style={{ gap: 8 }}>
          {p.tournaments.map((x) => (
            <Card key={x.tournamentId} onPress={() => router.push({ pathname: "/t/[slug]", params: { slug: x.slug } })} style={{ gap: 4 }}>
              <Body weight="semi">{x.name}</Body>
              <Body tone="ink2" size={12.5}>{[x.organization?.name, x.teamName, x.played ? `${x.won} won of ${x.played}` : null].filter(Boolean).join(" · ")}</Body>
            </Card>
          ))}
        </View>
      )}

      <SectionHeader title="Sessions and nights" />
      {p.sessions.length === 0 ? (
        <Body tone="ink2" size={13}>No sessions yet.</Body>
      ) : (
        <View style={{ gap: 8 }}>
          {p.sessions.map((s) => (
            <Card key={s.sessionId} style={{ gap: 4 }}>
              <Body weight="semi">{s.name}</Body>
              <Body tone="ink2" size={12.5}>{[day(s.date), s.organization?.name, `${s.played} played`, `${s.points} pts`].filter(Boolean).join(" · ")}</Body>
            </Card>
          ))}
        </View>
      )}

      {p.results.length > 0 && (
        <>
          <SectionHeader title="Results" />
          <View style={{ gap: 8 }}>
            {p.results.slice(0, 10).map((m) => (
              <MyMatchRow key={m.id} m={m} timezone={tz} />
            ))}
          </View>
        </>
      )}

      <SectionHeader title="Leagues and ranks" />
      <Card style={{ gap: 6 }}>
        <Chip label="Coming soon" />
        <Body tone="ink2" size={13}>League tables, points and your rank arrive with leagues.</Body>
      </Card>

      {p.organizations.length > 0 && (
        <>
          <SectionHeader title="Organisations" />
          <View style={{ gap: 8 }}>
            {p.organizations.map((o) => (
              <Card key={o.id} style={{ gap: 6 }}>
                <Body weight="semi" onPress={() => router.push({ pathname: "/org/[slug]", params: { slug: o.slug } })}>{o.name}</Body>
                {o.sharing ? (
                  <Body tone="ink2" size={12.5}>Sees your contact details.</Body>
                ) : o.canShare ? (
                  <>
                    <Body tone="ink2" size={12.5}>{`${o.name} has your entries but not your contact details. Share them so they can reach you about matches?`}</Body>
                    <Button
                      kind="ghost"
                      label={sharing === o.id ? "Sharing…" : "Share my details"}
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
                  <Body tone="ink2" size={12.5}>Does not see your contact details.</Body>
                )}
              </Card>
            ))}
          </View>
        </>
      )}
      {err ? <Body tone="live" size={13} style={{ marginTop: 8 }}>{err}</Body> : null}

      <SectionHeader title="Missing something?" />
      <Card style={{ gap: 8, borderColor: t.line }}>
        <Body tone="ink2" size={13}>Link more of your history with a player code or with the phone number the tournament has for you.</Body>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button kind="ghost" label="Player code" onPress={() => router.push("/player-code")} style={{ flex: 1 }} />
          <Button kind="ghost" label="Phone number" onPress={() => router.push("/link-phone" as Href)} style={{ flex: 1 }} />
        </View>
      </Card>
    </>
  );
}
