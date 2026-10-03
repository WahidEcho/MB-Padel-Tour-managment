import { View, type StyleProp, type ViewStyle } from "react-native";
import { router } from "expo-router";
import { session } from "../state/session";
import { useTheme } from "../theme/ThemeProvider";
import { Body } from "../ui/Text";
import { Card, Chip } from "../ui/Bits";

/**
 * Shown on Account, Discover and the Pass until a player who signed in with their
 * code has added and confirmed an email. Nothing for everyone else.
 */
export function RegistrationBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const { t } = useTheme();
  const user = session.use((s) => s.user);
  if (!user || user.registrationComplete !== false) return null;
  const waiting = user.pendingEmail;
  return (
    <Card onPress={() => router.push("/auth/complete")} style={[{ gap: 6, borderColor: t.ball, borderWidth: 1 }, style]} accessibilityLabel="Complete your registration">
      <View style={{ flexDirection: "row" }}>
        <Chip label={waiting ? "Check your inbox" : "Action needed"} ball />
      </View>
      <Body weight="semi" size={15.5}>{waiting ? "Confirm your email to finish" : "Complete your registration — add your email"}</Body>
      <Body tone="ink2" size={12.5}>
        {waiting
          ? `We sent a link to ${waiting}. Tap it to finish, or enter the code from the email.`
          : "You're signed in with your player code. Add an email so you can sign in on any phone."}
      </Body>
    </Card>
  );
}
