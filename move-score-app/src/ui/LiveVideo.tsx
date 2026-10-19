/**
 * A court's YouTube live video inside the app: the LIVE VIDEO badge, and the
 * player on the match page and in the live courts hero.
 *
 * The player is a WebView running YouTube's IFrame API (src/live/liveVideoHtml.ts):
 * a poster first, the video only once someone presses play, so a list of live
 * matches loads no players. When embedding is switched off, the stream has
 * ended, the video is missing or the player cannot load, the card says so and
 * offers "Open on YouTube" (also always offered under the player).
 *
 * react-native-webview is required lazily: a binary built before it was added
 * (an over-the-air update onto Move Score 1.0.x) has no native view for it, and
 * there the player falls back to the poster with "Open on YouTube" instead of
 * failing the screen.
 */
import { Component, createElement, useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { Linking, Platform, Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import { SITE_URL, delayNote, youtubeEmbedUrl, youtubeErrorKind, youtubeThumbnailUrl, youtubeWatchUrl, type MLiveVideo } from "@core";
import { useTheme } from "../theme/ThemeProvider";
import { Body, Eyebrow } from "./Text";
import { liveVideoHtml, parsePlayerMessage } from "../live/liveVideoHtml";

/** The few WebView props this player uses (typed here so nothing else depends on the package's types). */
interface WebViewLikeProps {
  source: { html: string; baseUrl?: string };
  style?: StyleProp<ViewStyle>;
  originWhitelist?: string[];
  javaScriptEnabled?: boolean;
  allowsInlineMediaPlayback?: boolean;
  mediaPlaybackRequiresUserAction?: boolean;
  allowsFullscreenVideo?: boolean;
  allowsAirPlayForMediaPlayback?: boolean;
  allowsPictureInPictureMediaPlayback?: boolean;
  scrollEnabled?: boolean;
  bounces?: boolean;
  onMessage?: (e: { nativeEvent: { data: string } }) => void;
  onError?: () => void;
  onShouldStartLoadWithRequest?: (req: { url: string; navigationType?: string }) => boolean;
}

let webViewImpl: ComponentType<WebViewLikeProps> | null | undefined;
function nativeWebView(): ComponentType<WebViewLikeProps> | null {
  if (webViewImpl !== undefined) return webViewImpl;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    webViewImpl = (require("react-native-webview") as { WebView?: ComponentType<WebViewLikeProps> }).WebView ?? null;
  } catch {
    webViewImpl = null;
  }
  return webViewImpl;
}

type Problem = "embedding_disabled" | "unavailable" | "error" | "ended" | "no_player";
const PROBLEM_TEXT: Record<Problem, string> = {
  embedding_disabled: "This video can only be watched on YouTube.",
  unavailable: "The live video is not available right now. It may not have started yet.",
  error: "The video could not be played here.",
  ended: "The live stream has ended.",
  no_player: "Update Move Score to watch inside the app.",
};

const openOnYouTube = (id: string) => void Linking.openURL(youtubeWatchUrl(id)).catch(() => {});

/** ● LIVE VIDEO: the court of this match is streamed now (words and dot, never colour alone). */
export function LiveVideoBadge({ compact = false }: { compact?: boolean }) {
  const { t } = useTheme();
  return (
    <View
      accessibilityLabel="Live video"
      testID="live-video-badge"
      style={{ flexDirection: "row", alignItems: "center", gap: 5, backgroundColor: t.live, borderRadius: 999, paddingHorizontal: compact ? 6 : 8, paddingVertical: compact ? 2 : 4, alignSelf: "flex-start" }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: "#FFFFFF" }} />
      <Eyebrow size={compact ? 8.5 : 9.5} style={{ color: "#FFFFFF", letterSpacing: 1 }}>
        Live video
      </Eyebrow>
    </View>
  );
}

/** Catches a native view that is missing or crashes, and shows the fallback instead of an error screen. */
class PlayerBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * The player, 16:9 at the given width. `autoStart` skips the poster (the hero's
 * Watch button already was the press).
 */
export function LiveVideoPlayer({ video, width, autoStart = false, showNote = true, onClose }: { video: MLiveVideo; width: number; autoStart?: boolean; showNote?: boolean; onClose?: () => void }) {
  const { t } = useTheme();
  const [playing, setPlaying] = useState(autoStart);
  const [problem, setProblem] = useState<Problem | null>(null);
  const height = Math.round((width * 9) / 16);
  useEffect(() => {
    setProblem(null);
  }, [video.youtubeId]);

  const onMessage = useCallback((e: { nativeEvent: { data: string } }) => {
    const m = parsePlayerMessage(e.nativeEvent.data);
    if (!m) return;
    if (m.type === "error") setProblem(youtubeErrorKind(m.code));
    else if (m.type === "api_failed") setProblem("error");
    else if (m.type === "state" && m.state === 0) setProblem("ended");
    else if (m.type === "state" && m.state === 1) setProblem(null);
  }, []);

  const fallback = (p: Problem) => (
    <View style={{ width, height, borderRadius: 16, overflow: "hidden", backgroundColor: "#000", alignItems: "center", justifyContent: "center", padding: 16 }} testID="live-video-fallback">
      <Image source={{ uri: youtubeThumbnailUrl(video.youtubeId) }} style={{ position: "absolute", width, height, opacity: 0.25 }} contentFit="cover" />
      <Body weight="semi" size={14} style={{ color: "#FFFFFF", textAlign: "center", marginBottom: 12 }}>
        {PROBLEM_TEXT[p]}
      </Body>
      <Pressable accessibilityRole="link" onPress={() => openOnYouTube(video.youtubeId)} style={{ backgroundColor: t.live, borderRadius: 999, paddingHorizontal: 16, paddingVertical: 9 }}>
        <Eyebrow size={11} style={{ color: "#FFFFFF" }}>Open on YouTube ↗</Eyebrow>
      </Pressable>
    </View>
  );

  let body: ReactNode;
  if (problem) body = fallback(problem);
  else if (!playing) {
    body = (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Watch the live video of ${video.court}`}
        onPress={() => setPlaying(true)}
        testID="live-video-play"
        style={({ pressed }) => [{ width, height, borderRadius: 16, overflow: "hidden", backgroundColor: "#000" }, pressed && { opacity: 0.85 }]}
      >
        <Image source={{ uri: youtubeThumbnailUrl(video.youtubeId) }} style={{ width, height, opacity: 0.85 }} contentFit="cover" />
        <View style={{ position: "absolute", left: 10, top: 10 }}>
          <LiveVideoBadge />
        </View>
        <View style={{ position: "absolute", left: width / 2 - 28, top: height / 2 - 28, width: 56, height: 56, borderRadius: 28, backgroundColor: "rgba(255,255,255,0.92)", alignItems: "center", justifyContent: "center" }}>
          <Body weight="bold" size={22} style={{ color: "#000", marginLeft: 3 }}>▶</Body>
        </View>
      </Pressable>
    );
  } else if (Platform.OS === "web") {
    // The app's web build: a plain iframe (react-native-web renders DOM elements).
    body = (
      <View style={{ width, height, borderRadius: 16, overflow: "hidden", backgroundColor: "#000" }}>
        {createElement("iframe", {
          src: youtubeEmbedUrl(video.youtubeId, { autoplay: true }),
          title: `Live video, ${video.court}`,
          allow: "autoplay; encrypted-media; picture-in-picture; fullscreen",
          allowFullScreen: true,
          style: { width: "100%", height: "100%", border: 0 },
        })}
      </View>
    );
  } else {
    const WebView = nativeWebView();
    const html = liveVideoHtml(video.youtubeId, SITE_URL);
    body =
      WebView && html ? (
        <PlayerBoundary fallback={fallback("no_player")}>
          <View style={{ width, height, borderRadius: 16, overflow: "hidden", backgroundColor: "#000" }} testID="live-video-webview">
            <WebView
              source={{ html, baseUrl: SITE_URL }}
              style={{ width, height, backgroundColor: "#000" }}
              originWhitelist={["*"]}
              javaScriptEnabled
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
              allowsFullscreenVideo
              allowsAirPlayForMediaPlayback
              allowsPictureInPictureMediaPlayback
              scrollEnabled={false}
              bounces={false}
              onMessage={onMessage}
              onError={() => setProblem("error")}
              // The player stays in the app: a tap on YouTube's logo or a link opens YouTube itself.
              onShouldStartLoadWithRequest={(req) => {
                const internal = req.url.startsWith(SITE_URL) || req.url === "about:blank" || /^https:\/\/(www\.)?(youtube-nocookie\.com|youtube\.com)\/(embed|iframe_api|s\/)/.test(req.url) || /^https:\/\/[a-z0-9.-]*(ytimg|googlevideo|gstatic|google)\.com\//.test(req.url);
                if (!internal && req.navigationType === "click") {
                  void Linking.openURL(req.url).catch(() => {});
                  return false;
                }
                return true;
              }}
            />
          </View>
        </PlayerBoundary>
      ) : (
        fallback("no_player")
      );
  }

  return (
    <View style={{ gap: 6 }} testID="live-video-player">
      {body}
      {showNote || onClose ? (
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          {showNote ? (
            <Body tone="ink3" size={11} style={{ flex: 1 }} numberOfLines={2}>
              {delayNote(video)}
            </Body>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          {onClose ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Close the video" onPress={onClose} hitSlop={8}>
              <Eyebrow size={10.5} tone="ink2">Close ✕</Eyebrow>
            </Pressable>
          ) : (
            <Pressable accessibilityRole="link" onPress={() => openOnYouTube(video.youtubeId)} hitSlop={8}>
              <Eyebrow size={10.5} tone="ink2">Open on YouTube ↗</Eyebrow>
            </Pressable>
          )}
        </View>
      ) : null}
    </View>
  );
}
