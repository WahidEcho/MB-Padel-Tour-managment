import { useMemo } from "react";
import Svg, { Rect } from "react-native-svg";
import QRCode from "qrcode";

/** A real, scannable QR code drawn as squares. */
export function QR({ value, size = 64, color = "#05060A", background = "#FFFFFF" }: { value: string; size?: number; color?: string; background?: string }) {
  const { n, cells } = useMemo(() => {
    const q = QRCode.create(value, { errorCorrectionLevel: "M" });
    const count = q.modules.size;
    const on: [number, number][] = [];
    for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) if (q.modules.get(x, y)) on.push([x, y]);
    return { n: count, cells: on };
  }, [value]);
  const pad = 2;
  return (
    <Svg width={size} height={size} viewBox={`${-pad} ${-pad} ${n + pad * 2} ${n + pad * 2}`}>
      <Rect x={-pad} y={-pad} width={n + pad * 2} height={n + pad * 2} fill={background} />
      {cells.map(([x, y]) => (
        <Rect key={`${x}.${y}`} x={x} y={y} width={1.02} height={1.02} fill={color} />
      ))}
    </Svg>
  );
}
