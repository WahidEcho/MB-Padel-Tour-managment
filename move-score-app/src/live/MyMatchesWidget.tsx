import { AccessoryWidgetBackground, HStack, Link, Spacer, Text, VStack, ZStack } from "@expo/ui/swift-ui";
import { containerBackground, font, foregroundStyle, frame, monospacedDigit, padding, widgetURL } from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";
import type { MWidgetMatch } from "@core";

/** Must match the widget's `name` in app.config.ts (expo-widgets plugin). */
export const MY_MATCHES_WIDGET = "MyMatches";

export type MyMatchesProps = {
  items: MWidgetMatch[];
  signedIn: boolean;
  updatedAt: number;
  /** The widget's words in the app's language (src/live/labels.ts); English without them. */
  labels?: { vs: string; liveCaps: string; final: string; tbc: string; noMatches: string; signIn: string; myMatches: string } | null;
};

/**
 * My matches: home screen (small, medium) and lock screen (rectangular, inline,
 * circular). Runs in the widget extension's JavaScript context, so — as with the
 * Live Activity — only its arguments, @expo/ui and JavaScript built-ins.
 * The timeline re-renders it at each match's start time (src/live/widgetSync.ts);
 * `env.date` is the entry's time, so a match that has started moves down.
 */
const MyMatches = (p: MyMatchesProps, env: WidgetEnvironment) => {
  "widget";
  const family = env.widgetFamily;
  const lock = family === "accessoryRectangular" || family === "accessoryInline" || family === "accessoryCircular";
  const yellow = lock ? "#FFFFFF" : "#FCFC00";
  const ink = lock ? "#FFFFFF" : "#E8ECF4";
  const dim = lock ? "#D0D0D0" : "#9AA4B8";
  const L = (p && p.labels) || null;
  const at = env.date ? env.date.getTime() : Date.now();
  const items = (p && p.items ? p.items : []).filter((m) => m.phase !== "final" || at - (m.at || 0) < 3 * 3600_000);
  // An upcoming match whose start time has passed is about to go live: keep it first.
  const next = items.find((m) => m.phase === "live") || items.find((m) => m.phase === "upcoming") || items[0] || null;
  const url = next ? `movescore://match/${next.id}` : "movescore://discover";
  const vs = (m: MWidgetMatch) => `${m.a} ${L ? L.vs : "v"} ${m.b}`;
  const when = (m: MWidgetMatch, size: number, color: string) =>
    m.phase === "live" ? (
      <Text modifiers={[font({ weight: "black", size }), monospacedDigit(), foregroundStyle(yellow)]}>{m.points || m.sets || (L ? L.liveCaps : "LIVE")}</Text>
    ) : m.phase === "final" ? (
      <Text modifiers={[font({ weight: "bold", size }), foregroundStyle(color)]}>{m.sets || (L ? L.final : "Final")}</Text>
    ) : m.at ? (
      <Text date={new Date(m.at)} dateStyle="time" modifiers={[font({ weight: "bold", size }), monospacedDigit(), foregroundStyle(color)]} />
    ) : (
      <Text modifiers={[font({ weight: "bold", size }), foregroundStyle(color)]}>{L ? L.tbc : "TBC"}</Text>
    );
  const empty = p && p.signedIn ? (L ? L.noMatches : "No matches coming up") : L ? L.signIn : "Sign in to see your matches";

  if (family === "accessoryInline") {
    return (
      <Text modifiers={[widgetURL(url)]}>{next ? `${vs(next)}${next.phase === "live" ? ` ${next.points || next.sets}` : next.court ? ` · ${next.court}` : ""}` : "Move Score"}</Text>
    );
  }

  if (family === "accessoryCircular") {
    return (
      <ZStack modifiers={[widgetURL(url)]}>
        <AccessoryWidgetBackground />
        <VStack>
          <Text modifiers={[font({ weight: "heavy", size: 10 }), foregroundStyle(ink)]}>{next ? next.a : "MS"}</Text>
          {next ? when(next, 12, ink) : <Text modifiers={[font({ size: 10 }), foregroundStyle(dim)]}>—</Text>}
        </VStack>
      </ZStack>
    );
  }

  if (family === "accessoryRectangular") {
    return (
      <VStack modifiers={[frame({ maxWidth: 400, alignment: "leading" }), widgetURL(url)]}>
        <Text modifiers={[font({ weight: "heavy", size: 12 }), foregroundStyle(ink)]}>{next ? vs(next) : "Move Score"}</Text>
        {next ? (
          <HStack>
            {when(next, 14, ink)}
            <Text modifiers={[font({ size: 12 }), foregroundStyle(dim)]}>{next.court ? ` ${next.court}` : ""}</Text>
          </HStack>
        ) : (
          <Text modifiers={[font({ size: 12 }), foregroundStyle(dim)]}>{empty}</Text>
        )}
      </VStack>
    );
  }

  const bg = containerBackground("#00000b", "widget");
  const header = <Text modifiers={[font({ weight: "heavy", size: 11 }), foregroundStyle(yellow)]}>{L ? L.myMatches : "MY MATCHES"}</Text>;

  if (!next) {
    return (
      <VStack modifiers={[bg, widgetURL(url), padding({ all: 4 })]}>
        {header}
        <Spacer />
        <Text modifiers={[font({ size: 13 }), foregroundStyle(dim)]}>{empty}</Text>
        <Spacer />
      </VStack>
    );
  }

  if (family === "systemSmall") {
    return (
      <VStack modifiers={[bg, widgetURL(url), frame({ maxWidth: 400, maxHeight: 400, alignment: "topLeading" })]}>
        {header}
        <Spacer />
        <Text modifiers={[font({ weight: "bold", size: 17 }), foregroundStyle(ink)]}>{next.a}</Text>
        <Text modifiers={[font({ weight: "bold", size: 17 }), foregroundStyle(ink)]}>{next.b}</Text>
        <Spacer />
        {when(next, 20, ink)}
        <Text modifiers={[font({ size: 12 }), foregroundStyle(dim)]}>{next.phase === "live" ? `${next.sets}${next.court ? ` · ${next.court}` : ""}` : next.court}</Text>
      </VStack>
    );
  }

  // systemMedium (and anything larger): up to three rows, each a link to its match
  // (a widget may carry only one widgetURL, so the rows use Link).
  return (
    <VStack modifiers={[bg, widgetURL(url), frame({ maxWidth: 800, maxHeight: 400, alignment: "topLeading" })]}>
      {header}
      {items.slice(0, 3).map((m) => (
        <Link key={m.id} destination={`movescore://match/${m.id}`}>
          <HStack modifiers={[padding({ top: 6 })]}>
            <VStack modifiers={[frame({ maxWidth: 600, alignment: "leading" })]}>
              <Text modifiers={[font({ weight: "bold", size: 15 }), foregroundStyle(ink)]}>{vs(m)}</Text>
              <Text modifiers={[font({ size: 11 }), foregroundStyle(dim)]}>{m.phase === "live" ? `${L ? L.liveCaps : "LIVE"} ${m.sets}${m.court ? ` · ${m.court}` : ""}` : m.court}</Text>
            </VStack>
            <Spacer />
            {when(m, 16, ink)}
          </HStack>
        </Link>
      ))}
      <Spacer />
    </VStack>
  );
};

export default createWidget<MyMatchesProps>(MY_MATCHES_WIDGET, MyMatches);
