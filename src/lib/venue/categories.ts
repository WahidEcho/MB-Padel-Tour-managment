import type { PoiCategory } from "./types";

/**
 * The map's category buttons, in order. A venue may replace them (venue doc
 * `categories`); "courts" is always first and is not a POI category.
 */
export const DEFAULT_CATEGORIES: PoiCategory[] = [
  { key: "toilets", label: "Toilets", icon: "toilet", color: "#2f80ed" },
  { key: "food", label: "Buffet / Café", icon: "cup", color: "#e07a1f" },
  { key: "medical", label: "Medical", icon: "cross", color: "#e5484d" },
  { key: "entrance", label: "Entrance / Gates", icon: "gate", color: "#12a150" },
  { key: "parking", label: "Parking", icon: "parking", color: "#4a5bd4" },
  { key: "referee", label: "Referee office", icon: "whistle", color: "#111827" },
  { key: "desk", label: "Tournament desk", icon: "info", color: "#0e9aa7" },
  { key: "lounge", label: "Players' lounge", icon: "sofa", color: "#8e4ec6" },
  { key: "prayer", label: "Prayer room", icon: "prayer", color: "#6b8e23" },
];

export const ICON_KEYS = ["toilet", "cup", "cross", "gate", "parking", "whistle", "info", "sofa", "prayer", "pin", "court", "camera", "star"] as const;
