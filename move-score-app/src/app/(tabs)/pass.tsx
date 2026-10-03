import { useMemo, useState } from "react";
import { Alert, Linking, Platform, TextInput, View } from "react-native";
import { router } from "expo-router";
import Animated, { FadeInDown, ZoomIn } from "react-native-reanimated";
import type { MPass } from "@core";
import { api, apiUrl, errorMessage } from "../../api/client";
import { useBundle, useConfig, useDiscover } from "../../api/queries";
import { registerDevice } from "../../push/register";
import { LoadState } from "../../ui/LoadState";
import { useFeaturedGroup } from "../../api/featured";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card, Chip, Empty, Flag, SectionHeader } from "../../ui/Bits";
import { PASS_H, PASS_W, PassCard, type PassEvent } from "../../ui/PassCard";
import { Pack } from "../../ui/Pack";
import { Pins } from "../../ui/Pins";
import { useFollowsOf } from "../../state/follows";
import { rememberPass, usePass } from "../../pass/usePass";
import { eventToday } from "../../pass/day";

function eventDays(a: string | null, b: string | null): string[] {
  if (!a) return [];
  const out: string[] = [];
  const end = Date.parse(`${b ?? a}T12:00:00Z`);
  for (let d = Date.parse(`${a}T12:00:00Z`); d <= end && out.length < 14; d += 86400000) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Wed 4 Nov" */
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

export default function PassTab() {
  const { t, calm } = useTheme();
  const group = useFeaturedGroup();
  const d = useDiscover();
  // Pins are the nations of this event's own tournaments, not whatever else is on.
  const slugs = group?.tournaments ?? [];
  const b0 = useBundle(slugs[0]?.slug);
  const b1 = useBundle(slugs[1]?.slug);
  const b2 = useBundle(slugs[2]?.slug);
  const b3 = useBundle(slugs[3]?.slug);
  const cfg = useConfig();
  const supporting = useFollowsOf("nation");
  const [opening, setOpening] = useState(false);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A failed open reseals the pack: a new key gives a fresh, untorn Pack.
  const [packKey, setPackKey] = useState(0);
  const q = usePass(group?.id);
  const { pass, owner } = q;
  const nations = useMemo(() => {
    const all = [b0.data, b1.data, b2.data, b3.data].flatMap((b) => b?.teams ?? []).filter((x) => x.code.length === 3);
    return [...new Map(all.map((x) => [x.code, x])).values()].sort((x, y) => x.name.localeCompare(y.name));
  }, [b0.data, b1.data, b2.data, b3.data]);
  if (!group) return <Screen onRefresh={() => d.refetch()}><Display size={24} style={{ marginTop: 8, marginBottom: 14 }}>My pass</Display>{d.data ? <Empty title="No event right now" body="Your pass appears when the next event opens." /> : <LoadState queries={[d]} what="your pass" />}</Screen>;
  const event: PassEvent = { name: group.name, venue: group.venue, city: group.city, days: eventDays(group.startsOn, group.endsOn) };
  const open = async () => {
    setOpening(true);
    try {
      const r = await api<{ pass: MPass }>("/api/mobile/v1/me/pass", { who: "me", body: { group: group.id, nationCode: supporting[0] } });
      rememberPass(group.id, r);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
      setPackKey((k) => k + 1);
    } finally {
      setTimeout(() => setOpening(false), 600);
    }
  };
  // Sends only what changed: the server leaves fields that are not in the body alone.
  const update = async (patch: { holderName: string } | { nationCode: string }) => {
    try {
      const r = await api<{ pass: MPass }>("/api/mobile/v1/me/pass", { who: "me", body: { group: group.id, ...patch } });
      rememberPass(group.id, r);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const saveName = () => {
    const next = name.trim();
    if (next) return void update({ holderName: next });
    if (!pass?.holderName) return;
    // An empty box clears the name only when the fan says so.
    if (Platform.OS === "web") {
      if (globalThis.confirm?.("Remove your name from the pass?")) void update({ holderName: "" });
      return;
    }
    Alert.alert("Remove your name?", "The pass will say “Move Score fan” instead.", [
      { text: "Keep it", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: () => void update({ holderName: "" }) },
    ]);
  };
  const nationIso = nations.find((n) => n.code === pass?.nationCode)?.iso2 ?? null;
  // The event's day where it is played, as the server stamps it (not the phone's UTC date).
  const today = eventToday(group.timezone);
  const stampedToday = Boolean(pass?.stamps.includes(today));
  return (
    <Screen onRefresh={() => q.refetch()}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8, marginBottom: 14 }}>
        <Display size={24}>My pass</Display>
        <Chip label={pass ? (pass.edition === "staff" ? "Accredited" : pass.onsiteUnlockedAt ? "On-site" : "Opened") : q.confirmedNone ? "Sealed" : "…"} ball={Boolean(pass?.onsiteUnlockedAt || pass?.edition === "staff")} />
      </View>
      <View style={{ alignItems: "center", paddingTop: 6 }}>
        {pass && !opening ? (
          <Animated.View entering={ZoomIn.springify().damping(12)}>
            <PassCard pass={pass} event={event} nationIso2={nationIso} today={today} />
          </Animated.View>
        ) : q.confirmedNone || opening ? (
          <Pack key={packKey} title={group.name} onOpen={() => void open()} />
        ) : (
          // Until the server has answered, the pass is unknown: never a sealed pack for a pass that exists.
          <View style={{ width: PASS_W, height: PASS_H, borderRadius: 24, borderWidth: 1, borderColor: t.line, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
            {/* No owner yet: this phone has not registered (it needs a connection once). */}
            <LoadState compact queries={[q]} what="your pass" onRetry={owner ? undefined : () => registerDevice(false)} />
          </View>
        )}
      </View>
      {error && (
        <Body tone="ink2" size={13} style={{ marginTop: 12, textAlign: "center" }} accessibilityRole="alert">
          {error}
        </Body>
      )}
      {pass && (
        <Animated.View entering={FadeInDown.delay(250)} style={{ gap: 8, marginTop: 18 }}>
          {!calm && (
            <Eyebrow tone="ink3" style={{ textAlign: "center", letterSpacing: 1.5 }}>
              {"📱  Tilt your phone"}
            </Eyebrow>
          )}
          <Button label={stampedToday ? `Stamped · ${dayLabel(today)}` : "Scan the venue code"} onPress={() => router.push("/scan")} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button kind="ghost" label="Share pass" onPress={() => router.push({ pathname: "/share/[matchId]", params: { matchId: "pass" } })} style={{ flex: 1 }} />
            {cfg.data?.flags.wallet ? (
              <Button kind="ghost" label="Add to Wallet" onPress={() => void Linking.openURL(apiUrl(`/api/mobile/v1/passes/${pass.id}/${process.env.EXPO_OS === "android" ? "google" : "apple"}`))} style={{ flex: 1 }} />
            ) : null}
          </View>
        </Animated.View>
      )}
      {nations.length > 0 && (
        <>
          <SectionHeader title="Nation pins" action={`${pass?.pins.length ?? 0} of ${nations.length}`} />
          <Pins nations={nations.map((n) => ({ code: n.code, iso2: n.iso2, name: n.name }))} got={pass?.pins ?? []} />
          <Body tone="ink3" size={12} style={{ marginTop: 12, textAlign: "center" }}>Tap a pin to open its nation. Follow a nation, or support it on-site, to collect its pin.</Body>
        </>
      )}
      {pass && (
        <View style={{ marginTop: 22 }}>
          <Body
            tone="blue"
            weight="semi"
            size={13}
            onPress={() => {
              // The box starts with the current name, so Save without typing changes nothing.
              if (!editing) setName(pass.holderName ?? "");
              setEditing((e) => !e);
            }}
            accessibilityRole="button"
            style={{ textAlign: "center" }}
          >
            {editing ? "Done" : "Edit name and nation"}
          </Body>
          {editing && (
            <>
              <SectionHeader title="Name on the pass" />
              <View style={{ flexDirection: "row", gap: 8 }}>
                <TextInput
                  defaultValue={pass.holderName ?? ""}
                  onChangeText={setName}
                  maxLength={40}
                  placeholder="Your name"
                  placeholderTextColor={t.ink3}
                  accessibilityLabel="Name on the pass"
                  style={{ flex: 1, backgroundColor: t.chip, borderColor: t.line, borderWidth: 1, borderRadius: 14, paddingHorizontal: 14, color: t.ink, fontSize: 15 }}
                />
                <Button label="Save" onPress={saveName} />
              </View>
              {nations.length > 0 && (
                <>
                  <SectionHeader title="Your nation" />
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                    {nations.map((n) => (
                      <Card key={n.code} onPress={() => void update({ nationCode: n.code })} style={{ paddingVertical: 8, paddingHorizontal: 10, flexDirection: "row", gap: 6, alignItems: "center", borderColor: pass.nationCode === n.code ? t.ball : t.line, borderWidth: pass.nationCode === n.code ? 2 : 1 }}>
                        <Flag iso2={n.iso2} code={n.code} size={18} />
                        <Body weight="semi" size={13}>{n.code}</Body>
                      </Card>
                    ))}
                  </View>
                </>
              )}
            </>
          )}
        </View>
      )}
    </Screen>
  );
}
