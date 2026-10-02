import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring } from "react-native-reanimated";
import { ApiError, api } from "../../api/client";
import { isOffline, useBundle, useCheers, useConfig, useLive } from "../../api/queries";
import { dayIn, makeView, timeIn } from "../../api/model";
import { SkinScope, useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { BackHeader } from "../../ui/Header";
import { Body, Display, Eyebrow, Num } from "../../ui/Text";
import { Card, Empty, Flag, SectionHeader, ToggleButton } from "../../ui/Bits";
import { TieCard } from "../../ui/Cards";
import { OfflineState, StaleBanner, failedOffline } from "../../ui/Offline";
import { toggleFollow, useFollowing } from "../../state/follows";
import { session } from "../../state/session";

/** The server takes at most this many taps per call. */
const MAX_PER_BATCH = 30;
/** After the server says "slow down", taps rest this long. */
const REST_MS = 5 * 60_000;
/** A sent batch the (CDN-cached) count has not caught up with by then is taken as counted anyway. */
const SETTLE_MS = 30_000;

/** A batch of taps the server accepted; `base + n` is the count that shows it arrived. */
type Sent = { nation: string; n: number; base: number; at: number };

/**
 * Tap-to-cheer: taps are counted on the phone and sent every few seconds. The
 * meter shows the server's count plus this phone's taps the count does not
 * include yet; once it does, the phone stops adding them, so nothing is counted twice.
 */
function CheerMeter({ tieId, a, b, live }: { tieId: string; a: { code: string; iso2: string | null }; b: { code: string; iso2: string | null }; live: boolean }) {
  const { t } = useTheme();
  const q = useCheers(tieId, live);
  const { refetch } = q;
  const pending = useRef<Record<string, number>>({});
  const sent = useRef<Sent[]>([]);
  const server = useRef<Record<string, number>>({});
  const restUntil = useRef(0);
  const [local, setLocal] = useState<Record<string, number>>({});
  const [note, setNote] = useState<string | null>(null);

  const settle = useCallback(() => {
    const now = Date.now();
    const done = sent.current.filter((s) => (server.current[s.nation] ?? 0) >= s.base + s.n || now - s.at > SETTLE_MS);
    if (!done.length) return;
    sent.current = sent.current.filter((s) => !done.includes(s));
    setLocal((l) => {
      const next = { ...l };
      for (const s of done) next[s.nation] = Math.max(0, (next[s.nation] ?? 0) - s.n);
      return next;
    });
  }, []);

  useEffect(() => {
    server.current = Object.fromEntries((q.data?.cheers ?? []).map((c) => [c.nation, c.count]));
    settle();
  }, [q.data, settle]);

  useEffect(() => {
    const id = setInterval(() => {
      settle();
      if (restUntil.current && Date.now() > restUntil.current) {
        restUntil.current = 0;
        setNote(null);
      }
      for (const [nation, n] of Object.entries(pending.current)) {
        if (!n) continue;
        pending.current[nation] = 0;
        // Earlier batches the count has not shown yet raise the bar for this one.
        const base = Math.max(server.current[nation] ?? 0, ...sent.current.filter((s) => s.nation === nation).map((s) => s.base + s.n));
        api(`/api/mobile/v1/ties/${tieId}/cheer`, { who: "me", body: { nation, n } })
          .then(() => {
            sent.current.push({ nation, n, base, at: Date.now() });
            void refetch();
          })
          .catch((e: unknown) => {
            // Not counted: take these taps back off the meter.
            setLocal((l) => ({ ...l, [nation]: Math.max(0, (l[nation] ?? 0) - n) }));
            if (e instanceof ApiError && e.status === 429) {
              restUntil.current = Date.now() + REST_MS;
              setNote("What a crowd! You've cheered a lot this hour, so the meter is resting your taps for a few minutes.");
            } else if (isOffline(e)) {
              setNote("You're offline, so those cheers didn't reach the meter. Try again when you're back.");
            }
          });
      }
    }, 3000);
    return () => clearInterval(id);
  }, [tieId, settle, refetch]);

  const count = (code: string) => (q.data?.cheers.find((c) => c.nation === code)?.count ?? 0) + (local[code] ?? 0);
  const ca = count(a.code);
  const cb = count(b.code);
  const share = ca + cb ? ca / (ca + cb) : 0.5;
  const scale = useSharedValue(1);
  const pulse = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const cheer = (code: string) => {
    if (!session.get().installToken) return;
    if (restUntil.current > Date.now()) return;
    // Taps beyond one batch would never reach the server, so they are not shown either.
    if ((pending.current[code] ?? 0) >= MAX_PER_BATCH) return;
    pending.current[code] = (pending.current[code] ?? 0) + 1;
    setLocal((l) => ({ ...l, [code]: (l[code] ?? 0) + 1 }));
    scale.value = withSequence(withSpring(1.06, { damping: 5 }), withSpring(1));
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  };
  return (
    <Card style={{ gap: 12 }}>
      <Eyebrow>Crowd meter</Eyebrow>
      <Animated.View style={[{ height: 14, borderRadius: 7, overflow: "hidden", flexDirection: "row", backgroundColor: t.chip }, pulse]}>
        <View style={{ flex: share, backgroundColor: t.ball }} />
        <View style={{ flex: 1 - share, backgroundColor: t.skinA }} />
      </Animated.View>
      <View style={{ flexDirection: "row", gap: 10 }}>
        {[a, b].map((n) => (
          <Pressable key={n.code} accessibilityRole="button" accessibilityLabel={`Cheer for ${n.code}, ${count(n.code)} cheers`} onPress={() => cheer(n.code)} style={({ pressed }) => ({ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 16, backgroundColor: t.chip, borderWidth: 1, borderColor: t.line, transform: [{ scale: pressed ? 0.96 : 1 }] })}>
            <Flag iso2={n.iso2} code={n.code} />
            <Body weight="bold">Cheer {n.code}</Body>
            <Num size={15} tone="ink2">{count(n.code)}</Num>
          </Pressable>
        ))}
      </View>
      {note ? (
        <Body tone="ink2" size={12.5} accessibilityLiveRegion="polite">
          {note}
        </Body>
      ) : null}
    </Card>
  );
}

function TieScreen({ id, slug }: { id: string; slug: string }) {
  const b = useBundle(slug);
  const l = useLive(slug);
  const cfg = useConfig();
  const starred = useFollowing("tie", id);
  const tie = l.data?.ties.find((x) => x.id === id);
  if (!b.data || !tie) {
    // Back is always there: loading, gone, or no signal.
    const failed = !b.data ? b : !l.data ? l : null;
    return (
      <Screen tabs={false}>
        <BackHeader label={b.data ? b.data.tournament.name.split(" ").slice(0, 3).join(" ") : "Back"} />
        {failed?.isError && failedOffline(failed) ? (
          <OfflineState what="this tie" onRetry={() => Promise.all([b.refetch(), l.refetch()])} />
        ) : failed?.isError || (b.data && l.data && !tie) ? (
          <Empty title="This tie is not available" body="It may have been moved or removed from the order of play." />
        ) : (
          <Body tone="ink2">Loading the tie…</Body>
        )}
      </Screen>
    );
  }
  const v = makeView(b.data, l.data);
  const a = v.team(tie.a);
  const bb = v.team(tie.b);
  const tz = b.data.tournament.timezone;
  return (
    <Screen tabs={false} onRefresh={() => l.refetch()}>
      <BackHeader label={b.data.tournament.name.split(" ").slice(0, 3).join(" ")} right={<ToggleButton compact on={starred} onLabel="★ Following" offLabel="☆ Follow tie" onPress={() => void toggleFollow("tie", id, b.data!.tournament.id)} />} />
      <StaleBanner queries={[l]} live={tie.status === "live"} />
      <Eyebrow>{[tie.roundName ?? (tie.stage === "group" ? "Group stage" : "Placement"), v.court(tie.courtId), tie.scheduledTime ? `${dayIn(tie.scheduledTime, tz)} ${timeIn(tie.scheduledTime, tz)}` : null].filter(Boolean).join(" · ")}</Eyebrow>
      <Display size={24} style={{ marginTop: 6, marginBottom: 14 }}>{`${a?.name ?? "TBD"} v ${bb?.name ?? "TBD"}`}</Display>
      <TieCard tie={tie} v={v} />
      {cfg.data?.flags.supporter_mode && a && bb && tie.status !== "completed" && (
        <>
          <SectionHeader title="Support" />
          <CheerMeter tieId={id} a={a} b={bb} live={tie.status === "live"} />
        </>
      )}
    </Screen>
  );
}

export default function TieRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const where = useQuery({ queryKey: ["tie-where", id], queryFn: () => api<{ tournamentSlug: string }>(`/api/mobile/v1/ties/${id}`), staleTime: Infinity });
  const b = useBundle(where.data?.tournamentSlug);
  if (!where.data) {
    return (
      <Screen tabs={false}>
        <BackHeader label="Back" />
        {where.isError && failedOffline(where) ? (
          <OfflineState what="this tie" onRetry={() => where.refetch()} />
        ) : where.isError ? (
          <Empty title="This tie is not available" />
        ) : (
          <Body tone="ink2">Loading the tie…</Body>
        )}
      </Screen>
    );
  }
  return (
    <SkinScope skin={b.data?.tournament.skin}>
      <TieScreen id={id} slug={where.data.tournamentSlug} />
    </SkinScope>
  );
}
