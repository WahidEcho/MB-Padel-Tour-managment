/**
 * The venue map in the app: the web map page (/t/<slug>/map?embed=app) in a
 * WebView, so the app and the web share one 3D renderer and one router. The app
 * feeds the phone's location and compass in (only after the map asks for them,
 * and only while this screen is open) and opens matches, ties and courts the
 * map sends out. Messages both ways are parsed with @core's bridge functions.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { embeddedMapUrl, parseFromMap, type ToMap } from "@core";
import { config } from "../../config";
import { useTheme } from "../../theme/ThemeProvider";
import { BackHeader } from "../../ui/Header";
import { Body } from "../../ui/Text";
import { Button, Empty } from "../../ui/Bits";
import { useVenue } from "../../api/queries";
import { openMatch, openTie, openTournament } from "../../nav/links";
import { startVenueLocation } from "../../venue/location";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function VenueMapScreen() {
  const { slug, court } = useLocalSearchParams<{ slug: string; court?: string }>();
  const { t } = useTheme();
  const venue = useVenue(slug);
  const web = useRef<WebView>(null);
  const stopLocation = useRef<(() => void) | null>(null);
  const wantLocation = useRef(false);
  const [failed, setFailed] = useState(false);
  const [cacheOnly, setCacheOnly] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The URL is fixed for the screen's life: theme changes go over the bridge, not a reload.
  const url = useMemo(
    () => embeddedMapUrl(config.apiBaseUrl, slug ?? "", { scheme: t.scheme, focus: court && UUID.test(court) ? `courtrow:${court}` : null }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug, court],
  );
  const origin = useMemo(() => new URL(config.apiBaseUrl).origin, []);

  const send = useCallback((m: ToMap) => {
    // Delivered as a MessageEvent, the way the page listens for the app.
    web.current?.injectJavaScript(`window.dispatchEvent(new MessageEvent("message",{data:${JSON.stringify(JSON.stringify(m))}}));true;`);
  }, []);

  useEffect(() => {
    send({ type: "theme", scheme: t.scheme });
  }, [t.scheme, send]);

  const stop = useCallback(() => {
    stopLocation.current?.();
    stopLocation.current = null;
  }, []);
  const start = useCallback(async () => {
    if (stopLocation.current) return;
    stopLocation.current = await startVenueLocation(send);
  }, [send]);

  // Location runs only while this screen is in front.
  useFocusEffect(
    useCallback(() => {
      if (wantLocation.current) void start();
      return stop;
    }, [start, stop]),
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      const m = parseFromMap(e.nativeEvent.data);
      if (!m) return;
      if (m.type === "want-location") {
        wantLocation.current = m.on;
        if (m.on) void start();
        else stop();
      } else if (m.type === "open-match") openMatch(m.matchId);
      else if (m.type === "open-tie") openTie(m.tieId);
      else if (m.type === "open-court" && m.slug) openTournament(m.slug);
    },
    [start, stop],
  );

  if (venue.isError && !venue.data) {
    return (
      <View style={{ flex: 1, backgroundColor: t.floor, paddingTop: 54, paddingHorizontal: 18 }}>
        <BackHeader label="Back" />
        <Empty title="No venue map yet" body="The organiser has not published a map of this venue." />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.floor }} testID="venue-map-screen">
      <View style={{ paddingTop: Platform.OS === "ios" ? 54 : 24, paddingHorizontal: 18 }}>
        <BackHeader label={venue.data?.doc.name ?? "Venue map"} />
      </View>
      {failed ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }}>
          <Body tone="ink2" style={{ textAlign: "center" }}>
            The map needs a connection the first time it opens. Try again when you have signal.
          </Body>
          <Button
            label="Try again"
            onPress={() => {
              setFailed(false);
              setAttempt((n) => n + 1);
            }}
          />
        </View>
      ) : (
        <WebView
          key={attempt}
          ref={web}
          source={{ uri: url }}
          style={{ flex: 1, backgroundColor: t.floor }}
          originWhitelist={[origin]}
          // Only the map's own site loads inside; anything else stays out.
          onShouldStartLoadWithRequest={(r) => r.url.startsWith(origin)}
          onMessage={onMessage}
          javaScriptEnabled
          domStorageEnabled
          geolocationEnabled={false}
          setSupportMultipleWindows={false}
          allowsBackForwardNavigationGestures={false}
          bounces={false}
          overScrollMode="never"
          cacheEnabled
          // Android: after a failed load, open the copy kept from the last visit.
          cacheMode={cacheOnly ? "LOAD_CACHE_ONLY" : "LOAD_DEFAULT"}
          startInLoadingState
          renderLoading={() => (
            <View style={{ position: "absolute", inset: 0, alignItems: "center", justifyContent: "center", backgroundColor: t.floor }}>
              <ActivityIndicator color={t.ink2} />
            </View>
          )}
          onError={() => {
            if (Platform.OS === "android" && !cacheOnly) {
              setCacheOnly(true);
              setAttempt((n) => n + 1);
            } else setFailed(true);
          }}
          onLoadEnd={() => send({ type: "theme", scheme: t.scheme })}
        />
      )}
    </View>
  );
}
