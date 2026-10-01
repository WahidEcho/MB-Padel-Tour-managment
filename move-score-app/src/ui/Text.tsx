import { Text as RNText, type TextProps, type TextStyle } from "react-native";
import { useTheme } from "../theme/ThemeProvider";
import { F } from "../theme/type";

type Tone = "ink" | "ink2" | "ink3" | "live" | "blue" | "skinA" | "onBall" | "ball";

function toneColor(t: ReturnType<typeof useTheme>["t"], tone: Tone) {
  switch (tone) {
    case "ink2":
      return t.ink2;
    case "ink3":
      return t.ink3;
    case "live":
      return t.live;
    case "blue":
      return t.blue;
    case "skinA":
      return t.skinA;
    case "onBall":
      return t.ballInk;
    case "ball":
      return t.ball;
    default:
      return t.ink;
  }
}

type P = TextProps & { tone?: Tone; size?: number; style?: TextStyle | TextStyle[] };

/** Headlines: Archivo Expanded, uppercase. */
export function Display({ tone = "ink", size = 28, style, ...rest }: P) {
  const { t } = useTheme();
  return (
    <RNText
      {...rest}
      maxFontSizeMultiplier={1.3}
      style={[{ fontFamily: F.display, fontSize: size, lineHeight: size * 0.98, letterSpacing: -0.2, textTransform: "uppercase", color: toneColor(t, tone) }, style as TextStyle]}
    />
  );
}

/** Scores and times: Archivo Condensed with tabular figures. */
export function Num({ tone = "ink", size = 20, style, ...rest }: P) {
  const { t } = useTheme();
  return <RNText {...rest} maxFontSizeMultiplier={1.4} style={[{ fontFamily: F.data, fontSize: size, color: toneColor(t, tone), fontVariant: ["tabular-nums"] }, style as TextStyle]} />;
}

export function Body({ tone = "ink", size = 15, weight = "regular", style, ...rest }: P & { weight?: "regular" | "medium" | "semi" | "bold" }) {
  const { t } = useTheme();
  const family = weight === "bold" ? F.bodyBold : weight === "semi" ? F.bodySemi : weight === "medium" ? F.bodyMedium : F.body;
  return <RNText {...rest} style={[{ fontFamily: family, fontSize: size, lineHeight: size * 1.4, color: toneColor(t, tone) }, style as TextStyle]} />;
}

/** Small uppercase labels with letter-spacing. */
export function Eyebrow({ tone = "ink2", size = 11, style, ...rest }: P) {
  const { t } = useTheme();
  return <RNText {...rest} style={[{ fontFamily: F.bodyBold, fontSize: size, letterSpacing: 1.6, textTransform: "uppercase", color: toneColor(t, tone) }, style as TextStyle]} />;
}
