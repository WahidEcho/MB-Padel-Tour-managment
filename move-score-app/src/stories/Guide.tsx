/**
 * The short guide to posting a story, in three steps (Profile → sign in → your
 * favourite match → Share → Move Score Stories). Shown when someone has watched
 * every story, and to a signed-out person who taps "+", with a way to sign in.
 * Signed in, "+" shows how to add one: from the pass, or from a match.
 */
import { View } from "react-native";
import { router } from "expo-router";
import { useTheme } from "../theme/ThemeProvider";
import { Sheet } from "../referee/Sheet";
import { Body, Display } from "../ui/Text";
import { Button } from "../ui/Bits";
import { useFeaturedGroup } from "../api/featured";
import { useT } from "../i18n";

export type GuideMode = "caughtUp" | "signIn" | "add";

function Step({ n, text, done }: { n: number; text: string; done?: boolean }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }} accessible accessibilityLabel={`${n}. ${text}`}>
      <View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: done ? t.success : t.ball, alignItems: "center", justifyContent: "center" }}>
        <Body weight="bold" size={14} style={{ color: done ? "#FFFFFF" : t.ballInk }}>
          {done ? "✓" : String(n)}
        </Body>
      </View>
      <Body size={15} style={{ flex: 1 }}>
        {text}
      </Body>
    </View>
  );
}

export function StoriesGuide({ mode, onClose, signedIn }: { mode: GuideMode | null; onClose: () => void; signedIn: boolean }) {
  const tr = useT();
  const group = useFeaturedGroup();
  const go = (to: () => void) => {
    onClose();
    to();
  };
  const title = mode === "signIn" ? tr("stories.signInTitle") : mode === "add" ? tr("stories.addTitle") : tr("stories.caughtUp");
  return (
    <Sheet open={mode !== null} onClose={onClose} title={tr("stories.title")}>
      <Display size={24}>{title}</Display>
      {mode === "signIn" ? <Body tone="ink2">{tr("stories.signInBody")}</Body> : null}
      {mode === "add" ? <Body tone="ink2">{tr("stories.addBody")}</Body> : null}
      {mode !== "add" ? (
        <View style={{ gap: 12, marginTop: 6 }}>
          {mode === "caughtUp" ? <Body weight="bold">{tr("stories.guideTitle")}</Body> : null}
          <Step n={1} text={tr("stories.guideStep1")} done={signedIn} />
          <Step n={2} text={tr("stories.guideStep2")} />
          <Step n={3} text={tr("stories.guideStep3")} />
        </View>
      ) : null}
      <View style={{ gap: 8, marginTop: 10 }}>
        {mode === "signIn" || (mode === "caughtUp" && !signedIn) ? <Button label={tr("stories.signInButton")} onPress={() => go(() => router.push("/account"))} /> : null}
        {mode === "add" && group ? <Button label={tr("stories.addPass")} onPress={() => go(() => router.push("/share/pass"))} /> : null}
        {mode === "add" || (mode === "caughtUp" && signedIn) ? <Button kind={mode === "add" && group ? "ghost" : "primary"} label={tr("stories.addMatch")} onPress={() => go(() => router.push("/matches"))} /> : null}
        <Button kind="ghost" label={mode === "signIn" ? tr("stories.notNow") : tr("stories.gotIt")} onPress={onClose} />
      </View>
    </Sheet>
  );
}
