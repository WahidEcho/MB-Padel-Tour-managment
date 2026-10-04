import { type ReactNode, type RefObject, useEffect, useState } from "react";
import { Keyboard, Platform, RefreshControl, ScrollView, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { checkNetwork } from "../api/network";
import { useTheme } from "../theme/ThemeProvider";
import { StageLight } from "./StageLight";

/** Content stays a comfortable reading width on tablets; the stage behind still fills the screen. */
export const CONTENT_MAX_WIDTH = 680;

/** iOS: whether the keyboard is up. It covers the tab bar, so the page needn't keep room for it. */
function useKeyboardUp(on: boolean) {
  const [up, setUp] = useState(false);
  useEffect(() => {
    if (!on) return;
    const show = Keyboard.addListener("keyboardWillShow", () => setUp(true));
    const hide = Keyboard.addListener("keyboardWillHide", () => setUp(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [on]);
  return on && up;
}

/**
 * Scrolls a Screen to its end once the keyboard is up: for a form that closes the
 * page, so what sits under the focused field shows above the keyboard too.
 */
export function revealEndAboveKeyboard(ref: RefObject<ScrollView | null>) {
  const go = () => setTimeout(() => ref.current?.scrollToEnd({ animated: true }), 60);
  if (Keyboard.isVisible()) return void go();
  const sub = Keyboard.addListener("keyboardDidShow", () => {
    sub.remove();
    clearTimeout(stop);
    go();
  });
  // A hardware keyboard never shows the soft one: don't leave the listener waiting.
  const stop = setTimeout(() => sub.remove(), 1500);
}

/**
 * A scrolling page on the stage: beams behind, safe areas respected, room for the tab bar.
 * A focused text field is kept above the keyboard (iOS insets; Android resizes the window).
 */
export function Screen({ children, onRefresh, stage = true, tabs = true, style, scrollRef }: { children: ReactNode; onRefresh?: () => Promise<unknown>; stage?: boolean; tabs?: boolean; style?: ViewStyle; scrollRef?: RefObject<ScrollView | null> }) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);
  const keyboardUp = useKeyboardUp(Platform.OS === "ios" && tabs);
  return (
    <View style={{ flex: 1, backgroundColor: t.floor }}>
      {stage && <StageLight />}
      <ScrollView
        ref={scrollRef}
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        contentContainerStyle={[{ paddingTop: insets.top + 8, paddingHorizontal: 18, paddingBottom: (tabs && !keyboardUp ? 110 : 30) + insets.bottom, width: "100%", maxWidth: CONTENT_MAX_WIDTH, alignSelf: "center" }, style]}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              tintColor={t.ball}
              colors={[t.ball]}
              progressBackgroundColor={t.surface}
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                try {
                  // With no signal a refetch waits for the connection: let go of the spinner
                  // (the offline banner or state says why) rather than spin until then.
                  const online = await checkNetwork();
                  await Promise.race([onRefresh(), new Promise((r) => setTimeout(r, online ? 15_000 : 800))]);
                } finally {
                  setRefreshing(false);
                }
              }}
            />
          ) : undefined
        }
      >
        {children}
      </ScrollView>
    </View>
  );
}
