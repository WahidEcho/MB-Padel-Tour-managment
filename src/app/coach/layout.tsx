import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Team coach · Move Score", robots: { index: false, follow: false } };

/** The coach's pages (migration 0037): their own team only, read-only. Never staff pages. */
export default function CoachLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="theme-auto flex flex-1 flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <Link href="/coach/team" className="flex items-baseline gap-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-accent">Move Score</span>
          <span className="font-bold">Team coach</span>
        </Link>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 p-4">{children}</main>
    </div>
  );
}
