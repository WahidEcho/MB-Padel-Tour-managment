import { redirect } from "next/navigation";
import { NOT_FOUND } from "@/lib/guard";
import { currentStaff, memberToken, setStaffCookie, staffOrgsFor, STAFF_WEB_HOURS } from "@/lib/auth/staff";
import { safeNextPath, staffHome } from "@/lib/auth/staffRedirect";
import { permissionRole } from "@/lib/orgs/roles";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * The organisation switcher, for a person who is staff in more than one (and for
 * platform admins, who can act in any). Switching re-checks the membership and
 * issues a fresh signed cookie for the chosen organisation.
 */
export default async function OrgSwitcherPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNextPath((await searchParams).next);
  const staff = await currentStaff();
  if (!staff || staff.kind !== "member" || !staff.userId) redirect(`/login${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  const orgs = await staffOrgsFor(staff.userId);

  async function switchOrg(formData: FormData) {
    "use server";
    const me = await currentStaff();
    if (!me || me.kind !== "member" || !me.userId) redirect("/login");
    const orgId = String(formData.get("org_id") ?? "");
    const choice = (await staffOrgsFor(me.userId)).find((o) => o.id === orgId);
    if (!choice) throw new Error(NOT_FOUND);
    await setStaffCookie(memberToken(me.userId, choice.id, choice.role), STAFF_WEB_HOURS);
    await audit({ organization_id: choice.id, actor_role: choice.role, action: "ORGANIZATION_SWITCHED" });
    redirect(safeNextPath(formData.get("next")) || staffHome(permissionRole(choice.role)));
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="card w-full max-w-sm space-y-4 p-6">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">Move Score</p>
          <h1 className="text-xl font-bold">Choose an organisation</h1>
          <p className="mt-1 text-sm text-muted">You are signed in to {staff.orgName}.</p>
        </div>
        <ul className="space-y-2" data-testid="org-choices">
          {orgs.map((o) => (
            <li key={o.id}>
              <form action={switchOrg}>
                <input type="hidden" name="org_id" value={o.id} />
                <input type="hidden" name="next" value={next ?? ""} />
                <button className={`w-full ${o.id === staff.orgId ? "btn-primary" : "btn-secondary"} justify-between`}>
                  <span>{o.name}</span>
                  <span className="text-xs capitalize opacity-80">{o.role}</span>
                </button>
              </form>
            </li>
          ))}
        </ul>
        <a href="/logout" className="block text-center text-sm text-muted hover:text-foreground">Log out</a>
      </div>
    </main>
  );
}
