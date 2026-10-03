import { useEffect, useState } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { browserSignInInFlight, resumeBrowserSignIn, SignInCancelled } from "../../auth/signIn";
import { errorMessage, ApiError } from "../../api/client";
import { useTheme } from "../../theme/ThemeProvider";
import { Screen } from "../../ui/Screen";
import { Button } from "../../ui/Bits";
import { Body, Display } from "../../ui/Text";

/**
 * Where the sign-in browser sheet comes back to (movescore://auth/callback).
 *
 * - iOS: the sheet hands the URL straight to the waiting sign-in; this screen never opens.
 * - Android: the redirect reaches the waiting sign-in and the router; this screen just steps back.
 *   If Android stopped the app while the browser was open, it finishes the sign-in here.
 * - Web preview: this page is the popup; it passes the URL to the window that opened it.
 */
export default function AuthCallback() {
  const { t } = useTheme();
  const p = useLocalSearchParams<{ code?: string; error?: string; error_code?: string; error_description?: string }>();
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (Platform.OS === "web" && WebBrowser.maybeCompleteAuthSession().type === "success") return;
    const leave = () => (router.canGoBack() ? router.back() : router.replace("/account"));
    if (browserSignInInFlight()) return leave();
    const q = (["code", "error", "error_code", "error_description"] as const)
      .filter((k) => typeof p[k] === "string" && p[k])
      .map((k) => `${k}=${encodeURIComponent(p[k] as string)}`)
      .join("&");
    resumeBrowserSignIn(`movescore://auth/callback?${q}`)
      .then((finished) => (finished ? router.replace("/account") : leave()))
      .catch((e: unknown) => {
        if (e instanceof SignInCancelled) return leave();
        setMsg(e instanceof ApiError || !(e instanceof Error) ? errorMessage(e) : e.message);
      });
    // Runs once for the URL this screen opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Screen tabs={false}>
      <View style={{ paddingTop: 80, alignItems: "center", gap: 16 }}>
        {msg ? (
          <>
            <Display size={22}>Not signed in</Display>
            <Body tone="ink2" size={14} style={{ textAlign: "center" }}>{msg}</Body>
            <Button label="Back to account" onPress={() => router.replace("/account")} style={{ alignSelf: "stretch" }} />
          </>
        ) : (
          <>
            <ActivityIndicator color={t.ink} />
            <Body tone="ink2" size={14}>Signing you in…</Body>
          </>
        )}
      </View>
    </Screen>
  );
}
