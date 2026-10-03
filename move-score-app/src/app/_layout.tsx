import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { Stack, useRootNavigationState } from "expo-router";
import * as Notifications from "expo-notifications";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useFonts } from "expo-font";
import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold } from "@expo-google-fonts/geist";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../api/queries";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider";
import { loadSession } from "../state/session";
import { openLink, registerDevice } from "../push/register";
import { getJson, setJson } from "../state/kv";
import { startMonitoring } from "../monitoring";
import { startSessionKeeper } from "../auth/keepAlive";

void SplashScreen.preventAutoHideAsync().catch(() => {});
startMonitoring();

const LAST_TAP = "ms.lastAlertTap";

/**
 * Opens what a tapped alert is about — including the tap that launched the app,
 * which arrives before the navigator exists, so nothing routes until it is ready.
 * Each tap is handled once (a relaunch reports the same last response again).
 */
function AlertTaps() {
  const response = Notifications.useLastNotificationResponse();
  const navReady = Boolean(useRootNavigationState()?.key);
  useEffect(() => {
    if (!navReady || !response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = response.notification.request.identifier;
    if (getJson<string | null>(LAST_TAP, null) === id) return;
    setJson(LAST_TAP, id);
    openLink(response.notification.request.content.data?.url as string | undefined);
  }, [navReady, response]);
  return null;
}

function Navigator() {
  const { t } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.floor }}>
      <StatusBar style={t.scheme === "dark" ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.floor }, animation: "default" }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="scan" options={{ presentation: "fullScreenModal", animation: "fade" }} />
        <Stack.Screen name="share/[matchId]" options={{ presentation: "transparentModal", animation: "fade" }} />
        <Stack.Screen name="referee/score/[matchId]" options={{ gestureEnabled: false }} />
      </Stack>
      {Platform.OS !== "web" && <AlertTaps />}
    </View>
  );
}

export default function RootLayout() {
  const [fonts] = useFonts({
    "Archivo-ExpandedBlack": require("../../assets/fonts/Archivo-ExpandedBlack.ttf"),
    "Archivo-ExpandedBold": require("../../assets/fonts/Archivo-ExpandedBold.ttf"),
    "Archivo-CondensedHeavy": require("../../assets/fonts/Archivo-CondensedHeavy.ttf"),
    "Archivo-CondensedBold": require("../../assets/fonts/Archivo-CondensedBold.ttf"),
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    Geist_700Bold,
  });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void loadSession().then(() => {
      setReady(true);
      // Refreshes the session at launch, on every return to the foreground and before it expires.
      startSessionKeeper();
      void registerDevice(false);
    });
  }, []);
  useEffect(() => {
    if (fonts && ready) void SplashScreen.hideAsync().catch(() => {});
  }, [fonts, ready]);
  if (!fonts || !ready) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <Navigator />
          </ThemeProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
