import Link from "next/link";
import { requireRole } from "@/lib/guard";

export const dynamic = "force-dynamic";

export default async function RefereeLayout({ children }: { children: React.ReactNode }) {
  const role = await requireRole(["referee", "admin", "manager"], "/referee");
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <Link href="/referee" className="flex items-center gap-2">
          <span className="text-sm font-bold uppercase tracking-widest text-accent">Move Beyond</span>
          <span className="text-sm font-semibold text-muted">Referee</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="badge bg-accent/15 text-accent capitalize">{role}</span>
          <a href="/logout" className="text-muted hover:text-foreground">Log out</a>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 p-4">{children}</main>
    </div>
  );
}
