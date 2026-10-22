import Svg, { Circle, Path, Rect } from "react-native-svg";

/**
 * Small line icons drawn with SVG. Emoji in labels can render as "?" boxes on
 * some iPhones with the app's fonts, so buttons and rows use these instead.
 */
export type GlyphName = "megaphone" | "help" | "stopwatch" | "clock" | "cup" | "restroom" | "drop" | "sun" | "warning" | "hourglass" | "phone" | "check" | "cross" | "dots" | "medical";

export function Glyph({ name, color, size = 18 }: { name: GlyphName; color: string; size?: number }) {
  const p = { fill: "none", stroke: color, strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" accessibilityElementsHidden importantForAccessibility="no">
      {name === "megaphone" && (
        <>
          <Path {...p} d="M3 10.5v3a1 1 0 0 0 1 1h2l5.5 4V5.5L6 9.5H4a1 1 0 0 0-1 1Z" />
          <Path {...p} d="M15.5 8.5a5 5 0 0 1 0 7" />
          <Path {...p} d="M18.5 6a8.5 8.5 0 0 1 0 12" />
        </>
      )}
      {name === "help" && (
        <>
          <Circle {...p} cx={12} cy={12} r={9} />
          <Path {...p} d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7" />
          <Circle cx={12} cy={17} r={1} fill={color} />
        </>
      )}
      {name === "stopwatch" && (
        <>
          <Circle {...p} cx={12} cy={13.5} r={7.5} />
          <Path {...p} d="M12 13.5V9.5M10 2.5h4M18.5 6.5l1.5-1.5" />
        </>
      )}
      {name === "clock" && (
        <>
          <Circle {...p} cx={12} cy={12} r={9} />
          <Path {...p} d="M12 7v5l3.5 2" />
        </>
      )}
      {name === "cup" && (
        <>
          <Path {...p} d="M4 9h12v4.5A5.5 5.5 0 0 1 10.5 19h-1A5.5 5.5 0 0 1 4 13.5V9Z" />
          <Path {...p} d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5v2.5M12 3.5v2.5" />
        </>
      )}
      {name === "restroom" && (
        <>
          <Circle {...p} cx={7} cy={4.5} r={1.8} />
          <Circle {...p} cx={17} cy={4.5} r={1.8} />
          <Path {...p} d="M5 9h4v6H8v6H6v-6H5V9ZM15 9h4l1.5 7H18v5h-2v-5h-2.5L15 9ZM12 3v18" />
        </>
      )}
      {name === "drop" && <Path {...p} d="M12 3s6.5 7 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 10 12 3 12 3Z" />}
      {name === "sun" && (
        <>
          <Circle {...p} cx={12} cy={12} r={4} />
          <Path {...p} d="M12 2.5v2M12 19.5v2M4.5 12h-2M21.5 12h-2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
        </>
      )}
      {name === "warning" && (
        <>
          <Path {...p} d="M12 3.5 2.5 20h19L12 3.5Z" />
          <Path {...p} d="M12 10v4.5" />
          <Circle cx={12} cy={17.2} r={1} fill={color} />
        </>
      )}
      {name === "check" && <Path {...p} strokeWidth={2.4} d="M5 12.5l4.5 4.5L19 7.5" />}
      {name === "cross" && <Path {...p} strokeWidth={2.4} d="M6 6l12 12M18 6L6 18" />}
      {name === "medical" && <Path {...p} d="M9.5 3.5h5v6h6v5h-6v6h-5v-6h-6v-5h6v-6Z" />}
      {name === "dots" && <Path {...p} strokeWidth={3} d="M6 12h.01M12 12h.01M18 12h.01" />}
      {name === "hourglass" && <Path {...p} d="M6.5 3h11M6.5 21h11M7.5 3c0 5 9 5 9 9s-9 4-9 9M16.5 3c0 5-9 5-9 9s9 4 9 9" />}
      {name === "phone" && (
        <>
          <Rect {...p} x={6.5} y={2.5} width={11} height={19} rx={2.5} />
          <Path {...p} d="M11 18.5h2" />
        </>
      )}
    </Svg>
  );
}
