import type { ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme/ThemeProvider";
import { Eyebrow } from "../ui/Text";

/**
 * The referee console's bottom sheet. It rides up with the keyboard, so a field
 * above it stays in sight; with Reduce Motion (the phone's or the app's calm
 * switch) it appears without sliding.
 */
export function Sheet({ open, onClose, children, title, tall }: { open: boolean; onClose: () => void; children: ReactNode; title: string; tall?: boolean }) {
  const { t, calm } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType={calm ? "fade" : "slide"} onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)" }} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        <View
          accessibilityViewIsModal
          style={{ backgroundColor: t.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 18, paddingBottom: insets.bottom + 18, gap: 10, maxHeight: tall ? "92%" : "80%" }}
        >
          <Eyebrow accessibilityRole="header">{title}</Eyebrow>
          <ScrollView contentContainerStyle={{ gap: 10 }} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
