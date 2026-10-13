import { db } from "@/lib/supabase";
import { requirePlatformPage } from "@/lib/guard";
import StateForm from "@/components/StateForm";
import { cleanPlan, PLAN_TIERS, SUBSCRIPTION_STATUSES } from "@/lib/orgs/profile";
import { MOVE_BEYOND_SLUG, ORG_ROLES, ROLE_LABELS } from "@/lib/orgs/roles";
import { createOrganization, decideApplication, decideRename, inviteToOrganization, saveBilling, setOrganizationStatus } from "./actions";

export const dynamic = "force-dynamic";

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  status: "applied" | "approved" | "rejected" | "suspended";
  city: string | null;
  country: string | null;
  application: Record<string, string | null> | null;
  plan: unknown;
  created_at: string;
  pending_name: string | null;
  pending_name_at: string | null;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" });

const APPLICATION_FIELDS: [string, string][] = [
  ["contact_name", "Contact"],
  ["contact_email", "Email"],
  ["contact_phone", "Phone"],
  ["sport", "Sport"],
  ["city", "City"],
  ["country", "Country"],
  ["website", "Website"],
  ["about", "About"],
];

function RoleSelect({ name, defaultValue, only }: { name: string; defaultValue: string; only?: string[] }) {
  return (
    <select name={name} defaultValue={defaultValue} className="input py-1 text-xs" aria-label="Role">
      {ORG_ROLES.filter((r) => !only || only.includes(r)).map((r) => (
        <option key={r} value={r}>{ROLE_LABELS[r]}</option>
      ))}
    </select>
  );
}

/**
 * Move Beyond's view of every organisation: applications to approve or turn
 * down, approved organisations (suspend, invite, billing fields), and creating
 * one directly. Platform admins only.
 */
export default async function PlatformOrganizationsPage() {
  await requirePlatformPage("/admin/platform/organizations");
  const [{ data: orgRows }, { data: memberRows }, { data: tRows }] = await Promise.all([
    db().from("organizations").select("id, slug, name, status, city, country, application, plan, created_at, pending_name, pending_name_at").order("created_at", { ascending: false }).limit(500),
    db().from("organization_members").select("organization_id, role").eq("status", "active").limit(10000),
    db().from("tournaments").select("organization_id").limit(20000),
  ]);
  const orgs = (orgRows ?? []) as OrgRow[];
  const members = new Map<string, { all: number; owners: number }>();
  for (const m of (memberRows ?? []) as { organization_id: string; role: string }[]) {
    const c = members.get(m.organization_id) ?? { all: 0, owners: 0 };
    c.all++;
    if (m.role === "owner") c.owners++;
    members.set(m.organization_id, c);
  }
  const events = new Map<string, number>();
  for (const t of (tRows ?? []) as { organization_id: string }[]) events.set(t.organization_id, (events.get(t.organization_id) ?? 0) + 1);
  const applied = orgs.filter((o) => o.status === "applied");
  const live = orgs.filter((o) => o.status === "approved" || o.status === "suspended");
  const rejected = orgs.filter((o) => o.status === "rejected");
  const renames = live.filter((o) => o.pending_name);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Organisations</h1>
        <p className="text-xs text-muted">
          Clubs, academies and organisers apply at /organizations/apply (or from the app); approving one invites its applicant as
          owner. Suspending one stops every member and event code of it on their next request. Billing fields are records only:
          nothing is charged in this build.
        </p>
      </div>

      <section className="space-y-3" data-testid="applications">
        <h2 className="text-lg font-bold">Applications ({applied.length})</h2>
        {applied.length === 0 && <p className="text-sm text-muted">No applications waiting.</p>}
        {applied.map((o) => (
          <div key={o.id} className="card space-y-3" data-testid="application">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-bold">{o.name}</h3>
              <span className="text-xs text-muted">applied {when(o.created_at)}</span>
            </div>
            <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">
              {APPLICATION_FIELDS.filter(([k]) => o.application?.[k]).map(([k, label]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{label}</dt>
                  <dd className="whitespace-pre-wrap break-words">{String(o.application?.[k])}</dd>
                </div>
              ))}
            </dl>
            <StateForm action={decideApplication} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="org_id" value={o.id} />
              <div>
                <label className="label" htmlFor={`inv-${o.id}`}>Invite as</label>
                <input id={`inv-${o.id}`} name="invite_email" type="email" defaultValue={o.application?.contact_email ?? ""} className="input py-1 text-xs" />
              </div>
              <RoleSelect name="invite_role" defaultValue="owner" only={["owner", "admin"]} />
              <div>
                <label className="label" htmlFor={`slug-${o.id}`}>Short name (optional)</label>
                <input id={`slug-${o.id}`} name="slug" maxLength={60} className="input py-1 font-mono text-xs" placeholder="from the name" />
              </div>
              <button name="decision" value="approve" className="btn-primary text-xs">Approve and invite</button>
              <button name="decision" value="reject" className="btn-secondary text-xs text-danger">Turn down</button>
            </StateForm>
          </div>
        ))}
      </section>

      {renames.length > 0 && (
        <section className="space-y-3" data-testid="renames">
          <h2 className="text-lg font-bold">Name changes waiting ({renames.length})</h2>
          {renames.map((o) => (
            <StateForm key={o.id} action={decideRename} className="card flex flex-wrap items-center gap-3" testId="rename">
              <input type="hidden" name="org_id" value={o.id} />
              <p className="flex-1 text-sm">
                <strong>{o.name}</strong> asks to be called <strong>{o.pending_name}</strong>
                {o.pending_name_at ? <span className="text-xs text-muted"> · {when(o.pending_name_at)}</span> : null}
              </p>
              <button name="decision" value="approve" className="btn-primary text-xs">Approve the new name</button>
              <button name="decision" value="reject" className="btn-secondary text-xs">Keep the old name</button>
            </StateForm>
          ))}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-bold">Create an organisation</h2>
        <StateForm action={createOrganization} className="card grid gap-3 sm:grid-cols-3" testId="create-org">
          <div>
            <label className="label" htmlFor="new-org-name">Name</label>
            <input id="new-org-name" name="name" required maxLength={120} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="new-org-slug">Short name (optional)</label>
            <input id="new-org-slug" name="slug" maxLength={60} className="input font-mono" placeholder="cairo-padel-club" />
          </div>
          <div>
            <label className="label" htmlFor="new-org-city">City</label>
            <input id="new-org-city" name="city" maxLength={80} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="new-org-country">Country</label>
            <input id="new-org-country" name="country" maxLength={80} className="input" />
          </div>
          <div>
            <label className="label" htmlFor="new-org-email">First owner or admin (email)</label>
            <input id="new-org-email" name="invite_email" type="email" required className="input" />
          </div>
          <div>
            <label className="label">Their role</label>
            <RoleSelect name="invite_role" defaultValue="owner" only={["owner", "admin"]} />
          </div>
          <div className="sm:col-span-3">
            <button className="btn-primary">Create and invite</button>
          </div>
        </StateForm>
      </section>

      <section className="space-y-3" data-testid="organizations">
        <h2 className="text-lg font-bold">Organisations ({live.length})</h2>
        {live.map((o) => {
          const plan = cleanPlan(o.plan);
          const m = members.get(o.id) ?? { all: 0, owners: 0 };
          return (
            <details key={o.id} className="card" data-testid="organization">
              <summary className="flex cursor-pointer flex-wrap items-baseline justify-between gap-2">
                <span className="font-bold">{o.name}</span>
                <span className="text-xs text-muted">
                  {o.slug} · {o.status} · {m.all} {m.all === 1 ? "member" : "members"} ({m.owners} {m.owners === 1 ? "owner" : "owners"}) ·{" "}
                  {events.get(o.id) ?? 0} events · {plan.tier}
                </span>
              </summary>
              <div className="mt-3 grid gap-4 lg:grid-cols-3">
                <StateForm action={saveBilling} className="space-y-2">
                  <input type="hidden" name="org_id" value={o.id} />
                  <p className="label">Billing (records only)</p>
                  <select name="tier" defaultValue={plan.tier} className="input py-1 text-xs" aria-label="Tier">
                    {PLAN_TIERS.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <label className="flex items-center gap-2 text-xs">
                    Commission %
                    <input name="commission_pct" type="number" min={0} max={100} step="0.01" defaultValue={plan.commission_pct} className="input w-24 py-1 text-xs" />
                  </label>
                  <select name="subscription_status" defaultValue={plan.subscription_status} className="input py-1 text-xs" aria-label="Subscription">
                    {SUBSCRIPTION_STATUSES.map((t) => (
                      <option key={t} value={t}>{t.replace("_", " ")}</option>
                    ))}
                  </select>
                  <button className="btn-secondary text-xs">Save billing</button>
                </StateForm>
                {o.status === "approved" ? (
                  <StateForm action={inviteToOrganization} className="space-y-2">
                    <input type="hidden" name="org_id" value={o.id} />
                    <p className="label">Invite someone</p>
                    <input name="invite_email" type="email" required className="input py-1 text-xs" aria-label="Email" />
                    <RoleSelect name="invite_role" defaultValue="owner" />
                    <button className="btn-secondary text-xs">Send invite</button>
                  </StateForm>
                ) : (
                  <p className="text-xs text-muted">Reinstate it to invite people.</p>
                )}
                {o.slug !== MOVE_BEYOND_SLUG && (
                  <StateForm
                    action={setOrganizationStatus}
                    className="space-y-2"
                    confirm={o.status === "approved" ? `Suspend ${o.name}? Its staff and codes stop working at once.` : undefined}
                  >
                    <input type="hidden" name="org_id" value={o.id} />
                    <p className="label">Status</p>
                    {o.status === "approved" ? (
                      <button name="status" value="suspended" className="btn-secondary text-xs text-danger">Suspend</button>
                    ) : (
                      <button name="status" value="approved" className="btn-primary text-xs">Reinstate</button>
                    )}
                  </StateForm>
                )}
              </div>
            </details>
          );
        })}
      </section>

      {rejected.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-bold">Turned down ({rejected.length})</h2>
          <ul className="text-sm text-muted">
            {rejected.map((o) => (
              <li key={o.id}>{o.name} · {o.application?.contact_email ?? "—"} · {when(o.created_at)}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
