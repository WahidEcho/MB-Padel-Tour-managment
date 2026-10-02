import type { Metadata } from "next";
import Link from "next/link";
import { Mail, OPERATOR, OPERATOR_SITE, PAGES } from "./legal";

export const metadata: Metadata = {
  title: { default: "Move Score", template: "%s · Move Score" },
  description: "Move Score: live scores, draws and alerts for the tennis and padel events you follow.",
};

/**
 * The Move Score pages on the web: product page, privacy policy, terms, support
 * and account deletion. Same dark look as the venue landing page (/v/[slug]).
 */
export default function MoveScoreLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="theme-dark flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border px-4 py-3">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2">
          <Link href="/movescore" className="leading-tight">
            <span className="block text-lg font-black">Move Score</span>
            <span className="block text-[10px] uppercase tracking-widest text-muted">by {OPERATOR}</span>
          </Link>
          <nav aria-label="Move Score pages" className="flex flex-wrap gap-1 text-xs font-semibold">
            {PAGES.slice(1).map(([href, label]) => (
              <Link key={href} href={href} className="rounded-lg px-2 py-1 text-muted hover:bg-card hover:text-foreground">
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-10 px-4 py-8">{children}</main>
      <footer className="border-t border-border px-4 py-6 text-xs text-muted">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3">
          <p>
            Move Score is made by{" "}
            <a href={OPERATOR_SITE} className="underline-offset-2 hover:underline">
              {OPERATOR}
            </a>
            . Questions: <Mail subject="Move Score" />
          </p>
          <nav aria-label="Legal" className="flex flex-wrap gap-3">
            {PAGES.map(([href, label]) => (
              <Link key={href} href={href} className="hover:text-foreground">
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}
