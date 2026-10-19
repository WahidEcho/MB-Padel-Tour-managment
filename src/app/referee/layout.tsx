import Link from "next/link";
import { requireStaff } from "@/lib/guard";
import MasterCalls from "@/components/referee/MasterCalls";

export const dynamic = "force-dynamic";

export default async function RefereeLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireStaff(["referee", "admin", "manager"], "/referee");
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <Link href="/referee" className="flex items-center gap-2">
          <span className="text-sm font-bold uppercase tracking-widest text-accent">{staff.orgName}</span>
          <span className="text-sm font-semibold text-muted">Referee</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          {staff.referee ? (
            <span className="badge bg-accent/15 text-accent" data-testid="referee-name">
              {staff.referee.name} · {staff.referee.role === "master_referee" ? "Master referee" : (staff.scopeCourt?.name ?? "Referee")}
            </span>
          ) : (
            <span className="badge bg-accent/15 text-accent capitalize">{staff.orgRole}</span>
          )}
          {staff.referee?.role === "master_referee" && (
            <Link href="/referee/master" className="font-semibold text-accent hover:underline" data-testid="master-link">Calls &amp; courts</Link>
          )}
          <a href="/logout" className="text-muted hover:text-foreground">Log out</a>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 space-y-4 p-4">
        {/* A master referee hears every court's call for assistance on every page (migration 0035). */}
        {staff.referee?.role === "master_referee" && <MasterCalls banner />}
        {children}
      </main>
    </div>
  );
}
