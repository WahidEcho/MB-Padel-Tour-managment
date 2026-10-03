/** Line icons for the story composer (24-unit grid, drawn with react-native-svg). */
import Svg, { Circle, Path, Rect } from "react-native-svg";

type P = { size?: number; color?: string };

const stroke = (color: string) => ({ stroke: color, strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" });

export function CloseIcon({ size = 20, color = "#FFFFFF" }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M6 6 L18 18 M18 6 L6 18" {...stroke(color)} />
    </Svg>
  );
}

export function BackIcon({ size = 22, color = "#FFFFFF" }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M15 5 L8 12 L15 19" {...stroke(color)} />
    </Svg>
  );
}

export function FlashIcon({ size = 20, color = "#FFFFFF", mode }: P & { mode: "off" | "on" | "auto" }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M13 2 L5 13.5 H11 L10 22 L19 10 H13 Z" {...stroke(color)} fill={mode === "on" ? color : "none"} />
      {mode === "off" ? <Path d="M3 3 L21 21" {...stroke(color)} /> : null}
      {mode === "auto" ? <Path d="M17 22 L19.5 15 L22 22 M17.8 20 H21.2" {...stroke(color)} strokeWidth={1.6} /> : null}
    </Svg>
  );
}

export function FlipIcon({ size = 22, color = "#FFFFFF" }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M4 12 A8 8 0 0 1 18 6.7 M18 2.5 V7 H13.5 M20 12 A8 8 0 0 1 6 17.3 M6 21.5 V17 H10.5" {...stroke(color)} />
    </Svg>
  );
}

export function LibraryIcon({ size = 22, color = "#FFFFFF" }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={3} y={4} width={18} height={16} rx={3} {...stroke(color)} />
      <Circle cx={9} cy={10} r={2} {...stroke(color)} />
      <Path d="M21 16 L16 11 L7 20" {...stroke(color)} />
    </Svg>
  );
}

export function CameraIcon({ size = 22, color = "#FFFFFF" }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M4 8 H7.5 L9.5 5 H14.5 L16.5 8 H20 A1 1 0 0 1 21 9 V19 A1 1 0 0 1 20 20 H4 A1 1 0 0 1 3 19 V9 A1 1 0 0 1 4 8 Z" {...stroke(color)} />
      <Circle cx={12} cy={13.5} r={3.8} {...stroke(color)} />
    </Svg>
  );
}

export function ShareIcon({ size = 20, color = "#FFFFFF" }: P) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d="M12 3 V15 M7 8 L12 3 L17 8 M5 13 V19 A2 2 0 0 0 7 21 H17 A2 2 0 0 0 19 19 V13" {...stroke(color)} />
    </Svg>
  );
}
