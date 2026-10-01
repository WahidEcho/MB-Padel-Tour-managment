import { useEffect, useState } from "react";
import { View } from "react-native";
import { Stack } from "expo-router";
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
import { listenForTaps, registerDevice } from "../push/register";
import { startMonitoring } from "../monitoring";

void SplashScreen.preventAutoHideAsync().catch(() => {});
startMonitoring();

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
      void registerDevice(false);
    });
    return listenForTaps();
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
