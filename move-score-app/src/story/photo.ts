/**
 * Getting a photo into the story: from the library, and a resize so a 12 MP
 * camera shot stays light in memory while still out-resolving the 1080×1920 export.
 */
import { Linking, Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { Image } from "expo-image";
import type { Photo } from "./model";

/** Long side kept: 1.5× the export's long side, so a pinch-zoom up to 1.5× stays sharp. */
const MAX_SIDE = 2880;

export async function prepare(p: Photo): Promise<Photo> {
  if (!p.width || !p.height) {
    // Some pickers leave the size out; the composer needs it to keep the photo covering the canvas.
    try {
      const ref = await Image.loadAsync(p.uri);
      p = { ...p, width: ref.width, height: ref.height };
    } catch {
      return p;
    }
  }
  if (Platform.OS === "web" || Math.max(p.width, p.height) <= MAX_SIDE) return p;
  try {
    const wide = p.width >= p.height;
    const ctx = ImageManipulator.manipulate(p.uri).resize(wide ? { width: MAX_SIDE } : { height: MAX_SIDE });
    const img = await ctx.renderAsync();
    const out = await img.saveAsync({ compress: 0.92, format: SaveFormat.JPEG });
    return { uri: out.uri, width: out.width, height: out.height };
  } catch {
    return p;
  }
}

/**
 * Opens the photo library. iOS 14+ and Android 13+ use the system picker, which
 * needs no library permission: the fan picks one photo and only that one is shared with the app.
 */
export async function pickFromLibrary(): Promise<Photo | null> {
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, allowsEditing: false, exif: false });
  const a = r.canceled ? null : r.assets[0];
  if (!a) return null;
  return prepare({ uri: a.uri, width: a.width, height: a.height });
}

export function openSettings() {
  void Linking.openSettings().catch(() => {});
}
