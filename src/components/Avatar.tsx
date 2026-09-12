import { deliveryWidth, focalPosition, portraitSrc, resolvePortrait, sizedImageSrc } from "@/lib/portrait";
import type { PhotoFields } from "@/lib/types";

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

/**
 * A person's face, or their initials.
 *
 * Pass the whole row as `person` wherever one is available: the stored original
 * can be several megabytes, and this asks the image CDN for a copy sized to the
 * box instead, framed on the person's focal point so the face survives the
 * circular crop. `photoUrl` alone still works for the few callers that only
 * have a URL.
 */
export default function Avatar({
  name,
  person,
  photoUrl,
  size = 40,
  eager = false,
}: {
  name: string;
  person?: Partial<PhotoFields> | null;
  photoUrl?: string | null;
  size?: number;
  /** True on anything destined for a TV, which never scrolls. */
  eager?: boolean;
}) {
  const portrait = resolvePortrait(person ?? { photo_url: photoUrl ?? null });
  const src = sizedImageSrc(portraitSrc(portrait), deliveryWidth(size));

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        width={size}
        height={size}
        loading={eager ? "eager" : "lazy"}
        className="rounded-full object-cover border border-border"
        style={{ width: size, height: size, objectPosition: focalPosition(portrait) }}
      />
    );
  }
  return (
    <span
      className="flex items-center justify-center rounded-full bg-accent/15 font-bold text-accent border border-accent/30"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
      aria-label={name}
    >
      {initials(name) || "?"}
    </span>
  );
}
