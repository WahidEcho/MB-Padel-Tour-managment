/* eslint-disable @next/next/no-img-element -- the wall paints CDN-sized files itself; next/image would re-proxy them */
import { focalPosition, portraitSrc, resolvePortrait, sizedImageSrc } from "@/lib/portrait";
import type { PublicPlayer } from "@/lib/public";
import s from "./tennis.module.css";

export function flagSrc(iso2: string | null | undefined): string | null {
  return iso2 && /^[a-z]{2}(-[a-z]+)?$/.test(iso2) ? `/flags/${iso2}.svg` : null;
}

export function Flag({ iso2, height, className = "" }: { iso2: string | null | undefined; height: number; className?: string }) {
  const src = flagSrc(iso2);
  if (!src) return null;
  return <img src={src} alt="" className={`${s.flag} ${className}`} style={{ height, width: Math.round(height * 4 / 3) }} />;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

/** "Giulia Safina Popa" → ["Giulia Safina", "Popa"]. */
export function splitName(name: string): [string, string] {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return ["", parts[0] ?? ""];
  return [parts.slice(0, -1).join(" "), parts[parts.length - 1]];
}

/**
 * A player's face on their flag. The cut-out when there is one, else the photo
 * framed on its focal point, else their initials on the flag — so a nation that
 * sent no photos still looks deliberate on the wall.
 */
export default function Face({
  player,
  iso2,
  size,
  className = "",
  cutout = false,
}: {
  player: PublicPlayer | null | undefined;
  iso2: string | null | undefined;
  /** Rendered width in stage pixels: picks the CDN size and the initials' type. */
  size: number;
  className?: string;
  /** Big cards: stand a transparent cut-out on the flag instead of cropping it. */
  cutout?: boolean;
}) {
  const portrait = resolvePortrait(player);
  const flag = flagSrc(iso2);
  const src = portraitSrc(portrait);
  const isCutout = cutout && Boolean(portrait.portraitUrl);
  return (
    <div className={`${s.face} ${className}`}>
      {flag && <img src={flag} alt="" className={s.faceFlag} />}
      <div className={s.faceScrim} />
      {src ? (
        <img
          src={sizedImageSrc(src, Math.min(1200, Math.round(size * 1.5))) ?? src}
          alt={player?.full_name ?? ""}
          className={isCutout ? s.faceCutout : s.faceImg}
          style={isCutout ? undefined : { objectPosition: focalPosition(portrait) }}
        />
      ) : (
        <span className={s.faceInitials} style={{ fontSize: Math.round(size * 0.38) }}>
          {initials(player?.full_name ?? "")}
        </span>
      )}
    </div>
  );
}
