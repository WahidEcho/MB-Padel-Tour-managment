import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ITF_RULES_PDF, ITF_TENNIS_RULES, rulePath, ruleSummary } from "@/lib/tennis/rulesOfTennis";

/**
 * Move Score's own short summary of one ITF Rule of Tennis, opened from the scoring
 * console's timer reference ("ITF Rule 29a · p. 14"). Public: our own words and a
 * button to the ITF's official 2026 Rules of Tennis, which decide.
 */
export function generateStaticParams() {
  return Object.keys(ITF_TENNIS_RULES).map((rule) => ({ rule }));
}

export async function generateMetadata({ params }: { params: Promise<{ rule: string }> }): Promise<Metadata> {
  const r = ruleSummary((await params).rule);
  return { title: r ? `ITF Rule ${r.rule}: ${r.title} · Move Score` : "ITF Rules of Tennis · Move Score" };
}

export default async function TennisRulePage({ params }: { params: Promise<{ rule: string }> }) {
  const r = ruleSummary((await params).rule);
  if (!r) notFound();
  const others = Object.values(ITF_TENNIS_RULES).filter((x) => x.rule !== r.rule);
  return (
    <main className="theme-auto min-h-screen bg-background text-foreground" data-testid="rule-page" data-rule={r.rule}>
      <div className="mx-auto max-w-2xl space-y-5 p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">ITF Rules of Tennis 2026</p>
        <h1 className="text-2xl font-bold">
          ITF Rule {r.rule} · {r.title}
        </h1>
        <p className="text-sm text-muted">{r.page} of the official Rules of Tennis</p>
        <section className="card space-y-2">
          <h2 className="label">In short</h2>
          {r.summary.map((p) => (
            <p key={p} className="text-base leading-relaxed">{p}</p>
          ))}
        </section>
        <section className="card space-y-2">
          <h2 className="label">In Move Score</h2>
          {r.inMoveScore.map((p) => (
            <p key={p} className="text-sm leading-relaxed">{p}</p>
          ))}
        </section>
        <a href={ITF_RULES_PDF} target="_blank" rel="noreferrer" className="btn-primary w-full py-3 text-base" data-testid="itf-official">
          Read the official ITF Rules of Tennis (PDF)
        </a>
        <p className="text-xs text-muted">
          This page is Move Score&apos;s own summary, written to help on court. It is not the ITF&apos;s text: the official rules decide.
        </p>
        <nav className="flex flex-wrap gap-2 text-xs">
          {others.map((o) => (
            <Link key={o.rule} href={rulePath(o.rule)} className="badge bg-card text-muted hover:text-foreground">
              ITF Rule {o.rule} · {o.title}
            </Link>
          ))}
        </nav>
      </div>
    </main>
  );
}
