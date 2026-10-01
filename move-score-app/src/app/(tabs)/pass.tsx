import { useMemo, useState } from "react";
import { Linking, TextInput, View } from "react-native";
import { router } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Animated, { FadeInDown, ZoomIn } from "react-native-reanimated";
import type { MPass } from "@core";
import { api, apiUrl, errorMessage } from "../../api/client";
import { useBundle, useConfig } from "../../api/queries";
import { useFeaturedGroup, useFeaturedSlugs } from "../../api/featured";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { Body, Display, Eyebrow } from "../../ui/Text";
import { Button, Card, Chip, Empty, Flag, SectionHeader } from "../../ui/Bits";
import { PassCard, type PassEvent } from "../../ui/PassCard";
import { Pack } from "../../ui/Pack";
import { session } from "../../state/session";
import { useFollowsOf } from "../../state/follows";

function eventDays(a: string | null, b: string | null): string[] {
  if (!a) return [];
  const out: string[] = [];
  const end = Date.parse(`${b ?? a}T12:00:00Z`);
  for (let d = Date.parse(`${a}T12:00:00Z`); d <= end && out.length < 14; d += 86400000) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}

export default function PassTab() {
  const { t } = useTheme();
  const qc = useQueryClient();
  const group = useFeaturedGroup();
  const slugs = useFeaturedSlugs();
  const b0 = useBundle(slugs[0]?.slug);
  const b1 = useBundle(slugs[1]?.slug);
  const cfg = useConfig();
  const installed = session.use((s) => Boolean(s.installToken));
  const supporting = useFollowsOf("nation");
  const [opening, setOpening] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A failed open reseals the pack: a new key gives a fresh, untorn Pack.
  const [packKey, setPackKey] = useState(0);
  const q = useQuery({
    queryKey: ["pass", group?.id],
    queryFn: () => api<{ pass: MPass | null }>(`/api/mobile/v1/me/pass?group=${group!.id}`, { who: "me" }),
    enabled: Boolean(group?.id && installed),
  });
  const pass = q.data?.pass ?? null;
  const nations = useMemo(() => {
    const all = [...(b0.data?.teams ?? []), ...(b1.data?.teams ?? [])].filter((x) => x.code.length === 3);
    return [...new Map(all.map((x) => [x.code, x])).values()].sort((x, y) => x.name.localeCompare(y.name));
  }, [b0.data, b1.data]);
  if (!group) return <Screen><Display size={26} style={{ marginTop: 8 }}>My pass</Display><Empty title="No event right now" body="Your pass appears when the next event opens." /></Screen>;
  const event: PassEvent = { name: group.name, venue: group.venue, city: group.city, days: eventDays(group.startsOn, group.endsOn) };
  const open = async () => {
    setOpening(true);
    try {
      const r = await api<{ pass: MPass }>("/api/mobile/v1/me/pass", { who: "me", body: { group: group.id, nationCode: supporting[0] } });
      qc.setQueryData(["pass", group.id], r);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
      setPackKey((k) => k + 1);
    } finally {
      setTimeout(() => setOpening(false), 600);
    }
  };
  const update = async (patch: { holderName?: string; nationCode?: string }) => {
    try {
      const r = await api<{ pass: MPass }>("/api/mobile/v1/me/pass", { who: "me", body: { group: group.id, holderName: patch.holderName ?? pass?.holderName ?? undefined, nationCode: patch.nationCode ?? pass?.nationCode ?? undefined } });
      qc.setQueryData(["pass", group.id], r);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const nationIso = nations.find((n) => n.code === pass?.nationCode)?.iso2 ?? null;
  return (
    <Screen onRefresh={() => q.refetch()}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <Display size={26}>My pass</Display>
        <Chip label={pass ? (pass.edition === "staff" ? "Accredited" : pass.onsiteUnlockedAt ? "On-site" : "Opened") : "Sealed"} ball={Boolean(pass?.onsiteUnlockedAt || pass?.edition === "staff")} />
      </View>
      <View style={{ alignItems: "center", marginTop: 18 }}>
        {pass && !opening ? (
          <Animated.View entering={ZoomIn.springify().damping(12)}>
            <PassCard pass={pass} event={event} nationIso2={nationIso} />
          </Animated.View>
        ) : (
          <Pack key={packKey} title={group.name} onOpen={() => void open()} />
        )}
      </View>
      {error && (
        <Body tone="ink2" size={13} style={{ marginTop: 12, textAlign: "center" }} accessibilityRole="alert">
          {error}
        </Body>
      )}
      {pass && (
        <Animated.View entering={FadeInDown.delay(250)} style={{ gap: 8, marginTop: 18 }}>
          <Button label={pass.onsiteUnlockedAt ? "Stamp today: scan the venue code" : "Scan the venue code"} onPress={() => router.push("/scan")} />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button kind="ghost" label="Share pass" onPress={() => router.push({ pathname: "/share/[matchId]", params: { matchId: "pass" } })} style={{ flex: 1 }} />
            {cfg.data?.flags.wallet ? (
              <Button kind="ghost" label="Add to Wallet" onPress={() => void Linking.openURL(apiUrl(`/api/mobile/v1/passes/${pass.id}/${process.env.EXPO_OS === "android" ? "google" : "apple"}`))} style={{ flex: 1 }} />
            ) : null}
          </View>
          <Body tone="ink3" size={12} style={{ textAlign: "center" }}>
            {pass.onsiteUnlockedAt ? `Stamped on ${pass.stamps.length} ${pass.stamps.length === 1 ? "day" : "days"}. Scan again each day you come.` : "Scan the code at the gate to unlock the on-site edition."}
          </Body>
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
            <Button label="Save" onPress={() => void update({ holderName: name })} />
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
          {cfg.data?.flags.pins && (
            <>
              <SectionHeader title="Nation pins" action={`${pass.pins.length} of ${nations.length}`} />
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                {nations.map((n) => {
                  const got = pass.pins.includes(n.code);
                  return (
                    <View key={n.code} style={{ width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", backgroundColor: got ? "#E0BC1F" : t.chip, borderWidth: got ? 0 : 1, borderStyle: "dashed", borderColor: t.line, opacity: got ? 1 : 0.5 }}>
                      <Flag iso2={n.iso2} code={n.code} size={30} />
                    </View>
                  );
                })}
              </View>
              <Eyebrow tone="ink3" style={{ marginTop: 8 }}>Follow a nation, or support it on-site, to collect its pin.</Eyebrow>
            </>
          )}
        </Animated.View>
      )}
      {!installed && <Body tone="ink3" size={12} style={{ marginTop: 14, textAlign: "center" }}>Connecting…</Body>}
    </Screen>
  );
}
