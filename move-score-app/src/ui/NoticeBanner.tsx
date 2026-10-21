/**
 * Notices on a tournament page: the organiser's play status (rain delay amber,
 * play suspended red, play resumed green) and the latest major announcement, from
 * the live feed (MLive.playStatus, absent on older servers) through noticeBanners (@core).
 */
import { useMemo } from "react";
import { View } from "react-native";
import { noticeBanners, type MLive, type NoticeTone } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow } from "./Text";
import { timeIn } from "../api/model";
import { useT } from "../i18n";
import type { Key } from "../i18n/t";

const EYEBROW: Record<NoticeTone, Key> = {
  delayed: "schedule.eyebrowDelayed",
  suspended: "schedule.eyebrowSuspended",
  resumed: "schedule.eyebrowResumed",
  major: "schedule.eyebrowAnnouncement",
};

/** The play status's own title (the organiser's announcements keep their words). */
const STATUS_TITLE: Record<Exclude<NoticeTone, "major">, Key> = {
  delayed: "schedule.playDelayed",
  suspended: "schedule.playSuspended",
  resumed: "schedule.playResumed",
};

export function NoticeBanners({ live, timeZone }: { live: MLive | undefined; timeZone: string }) {
  const { t } = useTheme();
  const tr = useT();
  // Re-read on every live poll; the pure rule decides what has expired.
  const banners = useMemo(() => noticeBanners({ playStatus: live?.playStatus ?? null, announcements: live?.announcements ?? [] }), [live]);
  if (!banners.length) return null;
  const color = (tone: NoticeTone) => (tone === "delayed" ? t.warning : tone === "suspended" ? t.live : tone === "resumed" ? t.success : t.blue);
  return (
    <View style={{ gap: 8, marginBottom: 12 }}>
      {banners.map((b) => {
        const c = color(b.tone);
        const resume = b.resumeAt ? tr("schedule.resumeAbout", { time: timeIn(b.resumeAt, timeZone) }) : null;
        const lines = [b.body, resume].filter(Boolean) as string[];
        const title = b.tone === "major" ? b.title : tr(STATUS_TITLE[b.tone]);
        return (
          <View
            key={b.key}
            accessibilityRole="alert"
            accessibilityLabel={[title, ...lines].join(". ")}
            style={{
              borderRadius: 16,
              borderWidth: 1,
              borderColor: c,
              borderLeftWidth: 5,
              backgroundColor: t.surface,
              paddingHorizontal: 14,
              paddingVertical: 10,
              gap: 2,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: c }} />
              <Eyebrow size={10} style={{ color: c, letterSpacing: 1 }}>{`${tr(EYEBROW[b.tone])} · ${timeIn(b.at, timeZone)}`}</Eyebrow>
            </View>
            <Body weight="bold" size={15}>{title}</Body>
            {lines.map((l) => (
              <Body key={l} tone="ink2" size={13}>{l}</Body>
            ))}
          </View>
        );
      })}
    </View>
  );
}
