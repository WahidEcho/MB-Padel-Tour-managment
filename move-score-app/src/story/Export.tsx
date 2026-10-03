/**
 * The 1080×1920 export. A second copy of the story is drawn at exactly
 * 1080 / pixel-ratio points, so the capture has one device pixel per output
 * pixel: nothing is scaled up, nothing is blurry. It is drawn with plain boxes
 * (no gestures, no animated transforms) from the poses the fan settled on.
 */
import { useEffect, useMemo, useRef } from "react";
import { PixelRatio, Platform, View } from "react-native";
import { Image } from "expo-image";
import { captureRef } from "react-native-view-shot";
import { LoadGate, LoadGateProvider, useGatedImage } from "./LoadGate";
import { Chrome, Scrims, Sticker } from "./Stickers";
import { DESIGN_W, EXPORT_H, EXPORT_W, photoBox, type LayoutId, type Photo, type PhotoPose, type StickerPose, type StoryInfo, type Tone } from "./model";

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function GatedPhoto({ photo, box }: { photo: Photo; box: ReturnType<typeof photoBox> }) {
  const gate = useGatedImage();
  return <Image source={{ uri: photo.uri }} style={{ position: "absolute", ...box }} contentFit="fill" transition={0} {...gate} />;
}

export interface ExportSpec {
  info: StoryInfo;
  layout: LayoutId;
  tone: Tone;
  photo: Photo;
  photoPose: PhotoPose;
  stickerPose: StickerPose;
}

/**
 * Mounted only while exporting, behind the composer. Waits for every image to
 * draw, then captures and hands back a file (a data URI on the web).
 */
export function ExportStage({ spec, onDone }: { spec: ExportSpec; onDone: (uri: string | null) => void }) {
  const pr = PixelRatio.get();
  const W = EXPORT_W / pr;
  const H = EXPORT_H / pr;
  const u = W / DESIGN_W;
  const gate = useMemo(() => new LoadGate(), []);
  const ref = useRef<View>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await gate.settled(4000);
        // Two frames for the decoded images to reach the screen; the pass has its own images and a QR.
        await frame();
        await frame();
        if (spec.layout === "pass") await wait(250);
        if (!alive) return;
        const uri = await captureRef(ref, { format: "jpg", quality: 0.94, width: EXPORT_W, height: EXPORT_H, result: Platform.OS === "web" ? "data-uri" : "tmpfile" });
        if (alive) onDone(uri);
      } catch {
        if (alive) onDone(null);
      }
    })();
    return () => {
      alive = false;
    };
    // One capture per mount; `onDone` is stable (the composer's useCallback).
  }, [gate, spec.layout, onDone]);
  const { info, layout, tone, photo, photoPose, stickerPose } = spec;
  return (
    <LoadGateProvider value={gate}>
      <View pointerEvents="none" style={{ position: "absolute", left: 0, top: 0 }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <View ref={ref} collapsable={false} style={{ width: W, height: H, overflow: "hidden", backgroundColor: "#000" }}>
          <GatedPhoto photo={photo} box={photoBox(photo, photoPose, W, H)} />
          <Scrims W={W} H={H} layout={layout} />
          <Chrome W={W} H={H} u={u} info={info} layout={layout} />
          {/* A zero-size anchor at the sticker's centre: flex centring puts the sticker on it. */}
          <View
            style={{
              position: "absolute",
              left: stickerPose.x * W,
              top: stickerPose.y * H,
              width: 0,
              height: 0,
              alignItems: "center",
              justifyContent: "center",
              transform: [{ rotate: `${stickerPose.r}rad` }, { scale: stickerPose.s }],
            }}
          >
            <View>
              <Sticker layout={layout} info={info} u={u} tone={tone} />
            </View>
          </View>
        </View>
      </View>
    </LoadGateProvider>
  );
}
