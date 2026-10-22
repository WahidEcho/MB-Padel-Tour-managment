import { useState } from "react";
import { View } from "react-native";
import { errorMessage } from "../api/client";
import { session } from "../state/session";
import { Screen } from "../ui/Screen";
import { BackHeader } from "../ui/Header";
import { Body, Display } from "../ui/Text";
import { Button, Card } from "../ui/Bits";
import { LoadState } from "../ui/LoadState";
import { useT } from "../i18n";
import { unblockStoryPoster, useMyStories } from "../stories/api";

/** Account → Stories: blocked people, each with Unblock (their stories show again). */
export default function BlockedStories() {
  const tr = useT();
  const signedIn = session.use((s) => Boolean(s.user));
  const q = useMyStories(signedIn);
  const [err, setErr] = useState<string | null>(null);
  const blocked = q.data?.blocked ?? [];
  return (
    <Screen tabs={false}>
      <BackHeader label={tr("ui.account")} fallback="/account" />
      <Display size={28}>{tr("stories.blockedTitle")}</Display>
      {!q.data ? <LoadState queries={[q]} what={tr("stories.blockedTitle")} /> : null}
      {q.data && !blocked.length ? <Body tone="ink2" style={{ marginTop: 12 }}>{tr("stories.noneBlocked")}</Body> : null}
      <View style={{ gap: 8, marginTop: 12 }}>
        {blocked.map((b) => (
          <Card key={b.key} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <Body weight="bold" style={{ flex: 1 }}>
              {b.name ?? tr("stories.fan")}
            </Body>
            <Button
              kind="ghost"
              label={tr("stories.unblock")}
              onPress={() => {
                setErr(null);
                unblockStoryPoster(b.key).catch((e) => setErr(errorMessage(e)));
              }}
            />
          </Card>
        ))}
      </View>
      {err ? <Body tone="live" style={{ marginTop: 10 }}>{err}</Body> : null}
    </Screen>
  );
}
