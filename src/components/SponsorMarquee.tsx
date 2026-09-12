/**
 * Sponsor and partner logos scrolling left to right.
 *
 * Pure CSS animation on a duplicated track, so it works on a venue TV, a phone
 * and inside the offline-capable pages without any JavaScript. The duplicate is
 * `aria-hidden` so screen readers announce each sponsor once.
 *
 * Respects prefers-reduced-motion: the animation stops and the row simply
 * scrolls by hand instead.
 */
export default function SponsorMarquee({
  logos,
  label = "Our partners",
  /** Bigger on a TV; the default suits phones and admin pages. */
  size = "normal",
  speedSeconds = 30,
}: {
  logos: string[];
  label?: string;
  size?: "normal" | "big";
  speedSeconds?: number;
}) {
  const clean = logos.filter(Boolean);
  if (clean.length === 0) return null;

  const height = size === "big" ? "h-20 sm:h-24" : "h-10 sm:h-12";
  // One pass should take longer when there are more logos, or a long list
  // whips past too fast to read.
  const duration = Math.max(12, Math.round((speedSeconds * clean.length) / 6));

  const track = (hidden: boolean) => (
    <ul
      className="flex shrink-0 items-center gap-8 pr-8"
      aria-hidden={hidden || undefined}
    >
      {clean.map((src, i) => (
        <li key={`${src}-${i}`} className="shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={hidden ? "" : `Sponsor ${i + 1}`}
            className={`${height} w-auto object-contain opacity-80 transition-opacity hover:opacity-100`}
            loading="lazy"
          />
        </li>
      ))}
    </ul>
  );

  return (
    <section className="w-full overflow-hidden py-3" aria-label={label}>
      {label && (
        <p className="mb-2 text-center text-xs font-bold uppercase tracking-widest text-muted">
          {label}
        </p>
      )}
      <div className="marquee-viewport relative overflow-hidden">
        <div className="marquee-track flex w-max" style={{ animationDuration: `${duration}s` }}>
          {track(false)}
          {track(true)}
        </div>
      </div>
    </section>
  );
}
