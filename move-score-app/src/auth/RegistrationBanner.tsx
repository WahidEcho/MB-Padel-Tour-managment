import { View, type StyleProp, type ViewStyle } from "react-native";
import { router } from "expo-router";
import { session } from "../state/session";
import { useTheme } from "../theme/ThemeProvider";
import { Body } from "../ui/Text";
import { Card, Chip } from "../ui/Bits";
import { useT } from "../i18n";

/**
 * Shown on Account, Discover and the Pass until a player who signed in with their
 * code has added and confirmed an email. Nothing for everyone else.
 */
export function RegistrationBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const { t } = useTheme();
  const tr = useT();
  const user = session.use((s) => s.user);
  if (!user || user.registrationComplete !== false) return null;
  const waiting = user.pendingEmail;
  return (
    <Card onPress={() => router.push("/auth/complete")} style={[{ gap: 6, borderColor: t.ball, borderWidth: 1 }, style]} accessibilityLabel={tr("auth.completeRegistration")}>
      <View style={{ flexDirection: "row" }}>
        <Chip label={waiting ? tr("auth.checkInbox") : tr("auth.actionNeeded")} ball />
      </View>
      <Body weight="semi" size={15.5}>{waiting ? tr("auth.bannerConfirmTitle") : tr("auth.bannerAddTitle")}</Body>
      <Body tone="ink2" size={12.5}>
        {waiting
          ? tr("auth.bannerConfirmBody", { email: waiting })
          : tr("auth.bannerAddBody")}
      </Body>
    </Card>
  );
}
