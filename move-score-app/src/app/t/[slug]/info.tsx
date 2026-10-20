/**
 * Event info for fans: the hero with the dates and a live "Open now · closes
 * 21:00" chip (worked out on the venue's clock), quick tiles (directions,
 * parking, food, toilets, medical: the venue map focused on the place when one
 * is published, else the phone's maps), today's hours, collapsible sections for
 * getting in, directions, parking, food and the FAQ, and Call / WhatsApp the
 * desk. Everything comes from GET /api/mobile/v1/t/<slug>/info (plain text,
 * cleaned by the server); nothing here is invented when a field is empty.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Linking, Platform, Pressable, View, type ScrollView } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import Svg, { Path } from "react-native-svg";
import Animated, { FadeIn, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { dateSpan, displayPhone, eventInfoDayLabel, hoursLine, openLabel, openState, telLink, todayHours, whatsAppLink, mailLink, type EventInfoPlace, type OpenState, type PublicEventInfo } from "@core";
import { useBundle, useEventInfo } from "../../../api/queries";
import { SkinScope, useTheme } from "../../../theme/ThemeProvider";
import { Screen } from "../../../ui/Screen";
import { BackHeader } from "../../../ui/Header";
import { Body, Display, Eyebrow } from "../../../ui/Text";
import { Button, Card, Chip, Empty, SectionHeader } from "../../../ui/Bits";
import { StaleBanner } from "../../../ui/Offline";
import { LoadState } from "../../../ui/LoadState";
import { openVenueMap } from "../../../nav/links";

const open = (url: string | null | undefined) => {
  if (url) void Linking.openURL(url).catch(() => {});
};
const tap = () => void Haptics.selectionAsync().catch(() => {});

/** The phone's own maps app first (Apple Maps on iPhone), the other as a fallback. */
function directionsUrl(info: PublicEventInfo): string | null {
  return Platform.OS === "ios" ? (info.links.apple ?? info.links.google) : (info.links.google ?? info.links.apple);
}

/** A maps search near the venue, for a tile with no map place and no text. */
function nearbySearch(what: string, info: PublicEventInfo): string {
  const near = info.directions.address || [info.venueName, info.city].filter(Boolean).join(", ");
  const q = encodeURIComponent(`${what} near ${near}`);
  return Platform.OS === "ios" ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`;
}

/* ---------------- glyphs ---------------- */

type GlyphKind = "directions" | "parking" | "food" | "toilets" | "medical";
const TILE_COLOR: Record<GlyphKind, string> = { directions: "#1E6BFF", parking: "#4a5bd4", food: "#e07a1f", toilets: "#2f80ed", medical: "#e5484d" };

function Glyph({ kind, color, size = 22 }: { kind: GlyphKind; color: string; size?: number }) {
  if (kind === "parking" || kind === "toilets") {
    return (
      <Body weight="bold" size={kind === "parking" ? size * 0.95 : size * 0.62} style={{ color, lineHeight: size * 1.05 }}>
        {kind === "parking" ? "P" : "WC"}
      </Body>
    );
  }
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {kind === "directions" && (
        <>
          <Path d="M12 2.5 21.5 12 12 21.5 2.5 12Z" fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
          <Path d="M8.5 14.5v-3h5V9l3.5 3.5-3.5 3.5v-2.5h-2.5v1.5z" fill={color} />
        </>
      )}
      {kind === "food" && (
        <>
          <Path d="M4.5 9h11.5v4.5A5.5 5.5 0 0 1 10.5 19h-.5A5.5 5.5 0 0 1 4.5 13.5Z" fill={color} />
          <Path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16" fill="none" stroke={color} strokeWidth={2} />
          <Path d="M8 3.5c-1 1.2 1 1.8 0 3M12 3.5c-1 1.2 1 1.8 0 3" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
        </>
      )}
      {kind === "medical" && <Path d="M9.5 3.5h5v6h6v5h-6v6h-5v-6h-6v-5h6z" fill={color} />}
    </Svg>
  );
}

/* ---------------- pieces ---------------- */

/** "Open now · closes 21:00", with a breathing dot while open. */
function OpenChip({ state }: { state: OpenState }) {
  const { t, calm } = useTheme();
  const isOpen = state.kind === "open";
  const color = isOpen ? (state.closingSoon ? t.warning : t.success) : t.ink2;
  const s = useSharedValue(0);
  useEffect(() => {
    if (!isOpen || calm) {
      cancelAnimation(s);
      s.value = 0;
      return;
    }
    s.value = withRepeat(withTiming(1, { duration: 1800 }), -1);
    return () => cancelAnimation(s);
  }, [s, isOpen, calm]);
  const ring = useAnimatedStyle(() => ({ opacity: 0.6 * (1 - s.value), transform: [{ scale: 1 + s.value * 1.5 }] }));
  return (
    <View
      accessibilityLabel={openLabel(state)}
      style={{ flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: t.surface, borderWidth: 1, borderColor: isOpen ? color : t.line }}
    >
      <View style={{ width: 8, height: 8 }}>
        {isOpen && <Animated.View style={[{ position: "absolute", width: 8, height: 8, borderRadius: 4, backgroundColor: color }, ring]} />}
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      </View>
      <Body weight="bold" size={13} style={{ color: isOpen ? color : t.ink }}>
        {openLabel(state)}
      </Body>
    </View>
  );
}

function Tile({ kind, label, sub, onPress }: { kind: GlyphKind; label: string; sub: string; onPress: () => void }) {
  const { t } = useTheme();
  const c = TILE_COLOR[kind];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${sub}`}
      onPress={() => {
        tap();
        onPress();
      }}
      style={({ pressed }) => [
        { flexBasis: "47%", flexGrow: 1, minHeight: 96, padding: 14, borderRadius: 20, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, gap: 10, justifyContent: "space-between" },
        pressed && { transform: [{ scale: 0.97 }], opacity: 0.9 },
      ]}
    >
      <View style={{ width: 40, height: 40, borderRadius: 13, backgroundColor: `${c}22`, alignItems: "center", justifyContent: "center" }}>
        <Glyph kind={kind} color={c} />
      </View>
      <View>
        <Body weight="bold" size={15}>{label}</Body>
        <Body tone="ink2" size={12} numberOfLines={1}>{sub}</Body>
      </View>
    </Pressable>
  );
}

/** A card that opens and closes; says expanded / collapsed to VoiceOver. */
function Section({ title, hint, expanded, onToggle, children }: { title: string; hint?: string; expanded: boolean; onToggle: () => void; children: ReactNode }) {
  const { t, calm } = useTheme();
  return (
    <View style={{ borderRadius: 22, backgroundColor: t.surface, borderWidth: 1, borderColor: t.line, overflow: "hidden" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={hint ? `${title}, ${hint}` : title}
        onPress={() => {
          tap();
          onToggle();
        }}
        style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 15, backgroundColor: pressed ? t.chip : "transparent" })}
      >
        <View style={{ flex: 1 }}>
          <Body weight="bold" size={16}>{title}</Body>
          {hint ? <Body tone="ink2" size={12.5} numberOfLines={1}>{hint}</Body> : null}
        </View>
        <Body tone="ink3" weight="bold" size={18} style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}>›</Body>
      </Pressable>
      {expanded && (
        <Animated.View entering={calm ? undefined : FadeIn.duration(180)} style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}>
          {children}
        </Animated.View>
      )}
    </View>
  );
}

function Para({ text }: { text: string }) {
  return (
    <View style={{ gap: 8 }}>
      {text.split("\n\n").map((p, i) => (
        <Body key={i} tone="ink" size={14.5}>{p}</Body>
      ))}
    </View>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={{ gap: 4 }}>
      <Eyebrow>{label}</Eyebrow>
      {children}
    </View>
  );
}

function Bullets({ items, mark, color }: { items: string[]; mark: string; color: string }) {
  return (
    <View style={{ gap: 6 }}>
      {items.map((x) => (
        <View key={x} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
          <Body weight="bold" size={14} style={{ color, width: 16, textAlign: "center" }}>{mark}</Body>
          <Body size={14.5} style={{ flex: 1 }}>{x}</Body>
        </View>
      ))}
    </View>
  );
}

/* ---------------- the screen ---------------- */

type Key = "hours" | "entry" | "directions" | "parking" | "food" | `faq-${number}`;

function Info({ slug }: { slug: string }) {
  const { t } = useTheme();
  const q = useEventInfo(slug);
  const scroll = useRef<ScrollView | null>(null);
  const offsets = useRef<Partial<Record<Key, number>>>({});
  const bodyY = useRef(0);
  const [openKeys, setOpenKeys] = useState<Set<Key>>(() => new Set<Key>(["entry"]));
  // The chip moves with the clock: "Opens today 09:00" becomes "Open now" without a refresh.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const info = q.data;
  if (!info) {
    return (
      <Screen tabs={false} onRefresh={() => q.refetch()}>
        <BackHeader label="Tournament" fallback={{ pathname: "/t/[slug]", params: { slug } }} />
        <LoadState queries={[q]} what="the event info" notFound={<Empty title="No event info yet" body="The organiser has not published it. Check back closer to the event." />} />
      </Screen>
    );
  }

  const toggle = (k: Key) =>
    setOpenKeys((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  /** Opens a section and brings it into view (a tile with no map place). */
  const reveal = (k: Key) => {
    setOpenKeys((s) => new Set(s).add(k));
    const y = offsets.current[k];
    if (y !== undefined) setTimeout(() => scroll.current?.scrollTo({ y: Math.max(0, bodyY.current + y - 12), animated: true }), 60);
  };
  const mark = (k: Key) => (e: { nativeEvent: { layout: { y: number } } }) => {
    offsets.current[k] = e.nativeEvent.layout.y;
  };
  const place = (p: EventInfoPlace) => info.map?.places[p] ?? null;
  const onMap = (p: EventInfoPlace) => {
    const focus = place(p);
    if (focus) openVenueMap(slug, null, focus);
    return Boolean(focus);
  };

  const state = openState(info.hours, now, info.timezone);
  const today = todayHours(info.hours, now, info.timezone);
  const span = dateSpan(info.startsOn, info.endsOn);
  const where = [info.venueName, info.city].filter(Boolean).join(", ");
  const e = info.entry;
  const d = info.directions;
  const go = directionsUrl(info);
  const hasEntry = Boolean(e.admission || e.ticketsNote || e.ticketsUrl || e.allowed.length || e.notAllowed.length || e.kids || e.photography || e.other);
  const hasDirections = Boolean(d.address || d.landmark || d.dropOff || d.transit || go);

  const tiles: { kind: GlyphKind; label: string; sub: string; onPress: () => void }[] = [];
  if (go) tiles.push({ kind: "directions", label: "Directions", sub: Platform.OS === "ios" && info.links.apple ? "Apple Maps" : "Google Maps", onPress: () => open(go) });
  tiles.push({
    kind: "parking",
    label: "Parking",
    sub: place("parking") ? "Show on venue map" : info.parking ? "Where to park" : "Nearby parking",
    onPress: () => onMap("parking") || (info.parking ? reveal("parking") : open(nearbySearch("parking", info))),
  });
  tiles.push({
    kind: "food",
    label: "Food & drinks",
    sub: place("food") ? "Show on venue map" : info.food ? "What's on" : "Nearby",
    onPress: () => onMap("food") || (info.food ? reveal("food") : open(nearbySearch("restaurants", info))),
  });
  if (place("toilets")) tiles.push({ kind: "toilets", label: "Toilets", sub: "Show on venue map", onPress: () => onMap("toilets") });
  tiles.push({
    kind: "medical",
    label: "Medical",
    sub: place("medical") ? "Show on venue map" : "Nearest hospital",
    onPress: () => onMap("medical") || open(nearbySearch("hospital", info)),
  });

  const desk = info.contacts[0];

  return (
    <Screen tabs={false} scrollRef={scroll} onRefresh={() => q.refetch()}>
      <BackHeader label="Tournament" fallback={{ pathname: "/t/[slug]", params: { slug } }} />
      <StaleBanner queries={[q]} />
      <View style={{ gap: 14 }}>
        {/* Hero */}
        <View style={{ borderRadius: 26, overflow: "hidden", borderWidth: 1, borderColor: t.line }}>
          <LinearGradient colors={[t.glowA, t.surface]} start={{ x: 0, y: 0 }} end={{ x: 0.9, y: 1 }} style={{ padding: 20, gap: 10 }}>
            <Eyebrow tone="ink2">Event info</Eyebrow>
            <Display size={28}>{info.eventName}</Display>
            {span || where ? (
              <Body tone="ink2" size={14} weight="semi">
                {[span, where].filter(Boolean).join(" · ")}
              </Body>
            ) : null}
            {info.intro ? <Body size={15}>{info.intro}</Body> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
              {state ? <OpenChip state={state} /> : null}
              {e.admission ? <Chip label={e.admission === "free" ? "FREE ENTRY" : "TICKETS NEEDED"} ball={e.admission === "free"} style={{ alignSelf: "center" }} /> : null}
            </View>
          </LinearGradient>
        </View>

        {/* Quick actions */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {tiles.map((x) => (
            <Tile key={x.kind} {...x} />
          ))}
        </View>

        <View style={{ gap: 14 }} onLayout={(ev) => (bodyY.current = ev.nativeEvent.layout.y)}>
          {/* Today's hours */}
          {info.hours.length > 0 && (
            <View onLayout={mark("hours")}>
              <Section
                title={today ? `Today · ${hoursLine(today)}` : "Opening hours"}
                hint={today?.note || (openKeys.has("hours") ? undefined : "Every day")}
                expanded={openKeys.has("hours")}
                onToggle={() => toggle("hours")}
              >
                <View style={{ gap: 2 }}>
                  {info.hours.map((h) => {
                    const isToday = today?.date === h.date;
                    return (
                      <View key={h.date} style={{ flexDirection: "row", justifyContent: "space-between", gap: 12, paddingVertical: 8, borderTopWidth: 1, borderColor: t.line }}>
                        <Body weight={isToday ? "bold" : "regular"} size={14.5}>{isToday ? `Today · ${eventInfoDayLabel(h.date)}` : eventInfoDayLabel(h.date)}</Body>
                        <View style={{ alignItems: "flex-end", flexShrink: 1 }}>
                          <Body weight={isToday ? "bold" : "semi"} size={14.5} tone={h.closed ? "ink3" : "ink"}>{hoursLine(h)}</Body>
                          {h.note ? <Body tone="ink2" size={12} style={{ textAlign: "right" }}>{h.note}</Body> : null}
                        </View>
                      </View>
                    );
                  })}
                </View>
                <Body tone="ink3" size={12}>{`Times at the venue (${info.timezone.replace(/_/g, " ")}).`}</Body>
              </Section>
            </View>
          )}

          {hasEntry && (
            <View onLayout={mark("entry")}>
              <Section title="Getting in" hint={e.admission === "free" ? "Free entry" : e.admission === "tickets" ? "Tickets needed" : "Entry rules"} expanded={openKeys.has("entry")} onToggle={() => toggle("entry")}>
                {e.ticketsNote ? <Para text={e.ticketsNote} /> : null}
                {e.ticketsUrl ? <Button label="Get tickets" onPress={() => open(e.ticketsUrl)} /> : null}
                {e.allowed.length ? (
                  <Labelled label="Allowed">
                    <Bullets items={e.allowed} mark="✓" color={t.success} />
                  </Labelled>
                ) : null}
                {e.notAllowed.length ? (
                  <Labelled label="Not allowed">
                    <Bullets items={e.notAllowed} mark="✕" color={t.live} />
                  </Labelled>
                ) : null}
                {e.kids ? (
                  <Labelled label="Kids">
                    <Para text={e.kids} />
                  </Labelled>
                ) : null}
                {e.photography ? (
                  <Labelled label="Photography">
                    <Para text={e.photography} />
                  </Labelled>
                ) : null}
                {e.other ? <Para text={e.other} /> : null}
              </Section>
            </View>
          )}

          {hasDirections && (
            <View onLayout={mark("directions")}>
              <Section title="How to get there" hint={d.address || where || undefined} expanded={openKeys.has("directions")} onToggle={() => toggle("directions")}>
                {d.address ? <Body weight="semi" size={15} selectable>{d.address}</Body> : null}
                {d.landmark ? (
                  <Labelled label="Nearest landmark">
                    <Body size={14.5}>{d.landmark}</Body>
                  </Labelled>
                ) : null}
                {d.dropOff ? (
                  <Labelled label="Taxi / Uber drop-off">
                    <Para text={d.dropOff} />
                  </Labelled>
                ) : null}
                {d.transit ? (
                  <Labelled label="Public transport">
                    <Para text={d.transit} />
                  </Labelled>
                ) : null}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                  {info.links.google ? <Button kind={Platform.OS === "ios" ? "ghost" : "primary"} label="Google Maps" onPress={() => open(info.links.google)} style={{ flexGrow: 1 }} /> : null}
                  {Platform.OS === "ios" && info.links.apple ? <Button label="Apple Maps" onPress={() => open(info.links.apple)} style={{ flexGrow: 1 }} /> : null}
                  {info.map ? <Button kind="ghost" label="Venue map" onPress={() => openVenueMap(slug, null, place("entrance"))} style={{ flexGrow: 1 }} /> : null}
                </View>
              </Section>
            </View>
          )}

          {info.parking ? (
            <View onLayout={mark("parking")}>
              <Section title="Parking" expanded={openKeys.has("parking")} onToggle={() => toggle("parking")}>
                <Para text={info.parking} />
                {place("parking") ? <Button kind="ghost" label="Show parking on the map" onPress={() => onMap("parking")} /> : null}
              </Section>
            </View>
          ) : null}

          {info.food ? (
            <View onLayout={mark("food")}>
              <Section title="Food & drinks" expanded={openKeys.has("food")} onToggle={() => toggle("food")}>
                <Para text={info.food} />
                {place("food") ? <Button kind="ghost" label="Show food on the map" onPress={() => onMap("food")} /> : null}
              </Section>
            </View>
          ) : null}

          {info.faqs.length > 0 && (
            <View style={{ gap: 10 }}>
              <SectionHeader title="FAQ" />
              {info.faqs.map((f, i) => (
                <Section key={f.q} title={f.q} expanded={openKeys.has(`faq-${i}`)} onToggle={() => toggle(`faq-${i}`)}>
                  <Para text={f.a} />
                </Section>
              ))}
            </View>
          )}

          {info.contacts.length > 0 && (
            <View style={{ gap: 10 }}>
              <SectionHeader title="Need help?" />
              {info.contacts.map((c) => (
                <Card key={`${c.label}${c.phone}${c.email}`} style={{ gap: 12, padding: 16 }}>
                  <View>
                    <Body weight="bold" size={16}>{c.label}</Body>
                    <Body tone="ink2" size={13}>{[c.phone ? displayPhone(c.phone) : "", c.email].filter(Boolean).join(" · ")}</Body>
                  </View>
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    {c.phone ? <Button label="Call" onPress={() => open(telLink(c.phone))} style={{ flex: 1 }} accessibilityLabel={`Call ${c.label}`} /> : null}
                    {c.phone && c.whatsapp ? (
                      <Button kind="ghost" label="WhatsApp" onPress={() => open(whatsAppLink(c.phone, `Hi, a question about ${info.eventName}: `))} style={{ flex: 1 }} accessibilityLabel={`WhatsApp ${c.label}`} />
                    ) : null}
                    {!c.phone && c.email ? <Button kind="ghost" label="Email" onPress={() => open(mailLink(c.email, info.eventName))} style={{ flex: 1 }} /> : null}
                  </View>
                </Card>
              ))}
            </View>
          )}

          {!desk && !info.faqs.length && !hasEntry && !info.hours.length ? <Body tone="ink3" size={13}>More details soon.</Body> : null}
        </View>
      </View>
    </Screen>
  );
}

export default function EventInfoScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const b = useBundle(slug);
  return (
    <SkinScope skin={b.data?.tournament.skin}>
      <Info slug={slug} />
    </SkinScope>
  );
}
