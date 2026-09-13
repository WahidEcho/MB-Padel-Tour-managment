import { deliveryWidth, focalPosition, portraitSrc, resolvePortrait, sizedImageSrc } from "@/lib/portrait";
import { initials } from "@/components/Avatar";
import type { CeremonyPerson } from "@/lib/tv/ceremony";

/** A player's portrait at a fixed size, or their initials when there is no photo. */
export default function PersonPortrait({ person, size, rounded = "rounded-3xl" }: { person: CeremonyPerson; size: number; rounded?: string }) {
  const portrait = resolvePortrait(person);
  const src = sizedImageSrc(portraitSrc(portrait), deliveryWidth(size));
  if (!src) {
    return (
      <span
        className={`flex shrink-0 items-center justify-center bg-accent/20 font-black text-accent ${rounded}`}
        style={{ width: size, height: size, fontSize: size * 0.34 }}
        aria-label={person.name}
      >
        {initials(person.name) || "?"}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={person.name}
      width={size}
      height={size}
      loading="eager"
      className={`shrink-0 object-cover ${rounded}`}
      style={{ width: size, height: size, objectPosition: focalPosition(portrait) }}
    />
  );
}
