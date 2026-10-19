import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ITF_REGULATIONS_URL, ITF_TEAM_REGULATIONS, regulationLabel, regulationPath, regulationSummary } from "@/lib/tennis/regulations";

/**
 * Move Score's own short summary of one ITF junior team competition regulation, opened
 * from a line-up warning's "ITF Reg. 43" link (web console, admin, and the app, which
 * opens it in the browser). Public: no event data, our own words, and a button to the
 * ITF's official regulations, which decide.
 */
export function generateStaticParams() {
  return Object.keys(ITF_TEAM_REGULATIONS).map((reg) => ({ reg }));
}

export async function generateMetadata({ params }: { params: Promise<{ reg: string }> }): Promise<Metadata> {
  const r = regulationSummary((await params).reg);
  return { title: r ? `${regulationLabel(r.reg)}: ${r.title} · Move Score` : "ITF regulations · Move Score" };
}

export default async function RegulationPage({ params }: { params: Promise<{ reg: string }> }) {
  const r = regulationSummary((await params).reg);
  if (!r) notFound();
  const others = Object.values(ITF_TEAM_REGULATIONS).filter((x) => x.reg !== r.reg);
  return (
    <main className="theme-auto min-h-screen bg-background text-foreground" data-testid="regulation-page" data-reg={r.reg}>
      <div className="mx-auto max-w-2xl space-y-5 p-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">ITF junior team competitions</p>
        <h1 className="text-2xl font-bold">
          {regulationLabel(r.reg)} · {r.title}
        </h1>
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
        <a href={ITF_REGULATIONS_URL} target="_blank" rel="noreferrer" className="btn-primary w-full py-3 text-base" data-testid="itf-official">
          Read the official ITF regulations
        </a>
        <p className="text-xs text-muted">
          This page is Move Score&apos;s own summary, written to help on court. It is not the ITF&apos;s text: the official regulations decide.
        </p>
        <nav className="flex flex-wrap gap-2 text-xs">
          {others.map((o) => (
            <Link key={o.reg} href={regulationPath(o.reg)} className="badge bg-card text-muted hover:text-foreground">
              {regulationLabel(o.reg)} · {o.title}
            </Link>
          ))}
        </nav>
      </div>
    </main>
  );
}
