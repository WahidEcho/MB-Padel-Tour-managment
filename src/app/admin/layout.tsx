import Link from "next/link";
import { requireStaff } from "@/lib/guard";
import AdminNav from "./AdminNav";
import LineupNotices from "@/components/lineups/LineupNotices";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Every page under /admin checks again for itself (a layout is not re-run on
  // client navigation); this one only decides what the header shows.
  const staff = await requireStaff(["admin", "manager"], "/admin/tournaments");
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <Link href="/admin/tournaments" className="flex items-center gap-2">
          <span className="text-sm font-bold uppercase tracking-widest text-accent">{staff.orgName}</span>
          <span className="text-sm font-semibold text-muted">Tournament Console</span>
        </Link>
        <div className="flex items-center gap-3 text-sm">
          <span className="badge bg-accent/15 text-accent capitalize" data-testid="staff-role">{staff.orgRole}</span>
          {staff.kind === "member" && (
            <Link href="/staff/orgs" className="text-muted hover:text-foreground">Switch organisation</Link>
          )}
          <a href="/logout" className="text-muted hover:text-foreground">Log out</a>
        </div>
      </header>
      <AdminNav canManageCodes={staff.role === "admin" || staff.role === "manager"} canManageOrg={staff.role === "admin" && staff.kind === "member"} platformAdmin={staff.platformAdmin} />
      <main className="mx-auto w-full max-w-6xl flex-1 space-y-4 p-4">
        {/* A court referee accepted a line-up exception (ITF Reg. 43 / 50): the organiser hears it at once. */}
        <LineupNotices />
        <div>{children}</div>
      </main>
    </div>
  );
}
