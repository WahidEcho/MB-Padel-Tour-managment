import Link from "next/link";

/**
 * Shared bits for the Move Score product, legal and support pages. These pages
 * are linked from the app (Account → About) and from the App Store / Play listing,
 * so they stay static, readable without JavaScript and free of event names.
 */

// OWNER TO CONFIRM before store submission: the public support / privacy contact
// address. This is a placeholder; replace it with the address Move Beyond wants
// listed (it appears on every Move Score page and in the store listing).
export const SUPPORT_EMAIL = "mohamed.wahid.gm@gmail.com";

export const OPERATOR = "Move Beyond";
export const OPERATOR_SITE = "https://mbeg.org";
// Change when the wording of the privacy policy or terms changes.
export const LAST_UPDATED = "2 October 2026";

export const PAGES = [
  ["/movescore", "Move Score"],
  ["/movescore/support", "Support"],
  ["/movescore/privacy", "Privacy"],
  ["/movescore/terms", "Terms"],
  ["/movescore/delete-account", "Delete account"],
] as const;

export function Mail({ subject, children }: { subject?: string; children?: React.ReactNode }) {
  const href = `mailto:${SUPPORT_EMAIL}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`;
  return (
    <a href={href} className="font-semibold text-accent underline-offset-2 hover:underline">
      {children ?? SUPPORT_EMAIL}
    </a>
  );
}

export function PageTitle({ eyebrow, title, intro }: { eyebrow?: string; title: string; intro?: React.ReactNode }) {
  return (
    <header className="space-y-2">
      {eyebrow && <p className="text-xs font-bold uppercase tracking-widest text-accent">{eyebrow}</p>}
      <h1 className="text-3xl font-black leading-tight sm:text-4xl">{title}</h1>
      {intro && <div className="text-base text-muted">{intro}</div>}
    </header>
  );
}

export function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 space-y-3">
      <h2 className="text-xl font-bold">{title}</h2>
      <div className="space-y-3 text-[15px] leading-relaxed text-foreground/90">{children}</div>
    </section>
  );
}

export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1.5 pl-5 marker:text-muted">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

export function Updated() {
  return <p className="text-xs text-muted">Last updated {LAST_UPDATED}</p>;
}

export function InlineLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="font-semibold text-accent underline-offset-2 hover:underline">
      {children}
    </Link>
  );
}
