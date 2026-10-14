import StateForm from "@/components/StateForm";
import Link from "next/link";
import { db } from "@/lib/supabase";
import { requirePlatformPage } from "@/lib/guard";
import { DEFAULT_FLAGS } from "@/lib/mobile/server";
import { DISCOVER_ORDER_KEY, inDiscoverOrder, parseDiscoverOrder } from "@/lib/platform/discoverOrder";
import { saveDiscoverOrder, saveFlags } from "./actions";

export const dynamic = "force-dynamic";

interface Item {
  id: string;
  kind: "group" | "tournament";
  name: string;
  detail: string;
  featured: boolean;
  live: boolean;
}

/**
 * Move Beyond's settings for the app as a whole: the order of the Discover hero
 * (featured events and live tournaments) and the app's feature flags. Admins only.
 */
export default async function DiscoverSettingsPage() {
  await requirePlatformPage("/admin/platform/discover");
  const [groupsRes, tournamentsRes, settingsRes, liveRes] = await Promise.all([
    db().from("event_groups").select("id, name, city, starts_on, ends_on, featured_rank").order("featured_rank", { ascending: true }),
    db()
      .from("tournaments")
      .select("id, name, sport, status, event_group_id, public_access_enabled")
      .eq("kind", "tournament")
      .in("status", ["active", "completed", "draft"])
      .order("created_at", { ascending: false })
      .limit(200),
    db().from("platform_settings").select("key, value_json").in("key", [DISCOVER_ORDER_KEY, "flags"]),
    db().from("matches").select("tournament_id").in("status", ["live", "paused"]),
  ]);
  const settings = new Map(((settingsRes.data ?? []) as { key: string; value_json: unknown }[]).map((r) => [r.key, r.value_json]));
  const order = parseDiscoverOrder(settings.get(DISCOVER_ORDER_KEY));
  const liveTournaments = new Set(((liveRes.data ?? []) as { tournament_id: string }[]).map((m) => m.tournament_id));
  const tournaments = (tournamentsRes.data ?? []) as {
    id: string;
    name: string;
    sport: string;
    status: string;
    event_group_id: string | null;
    public_access_enabled: boolean;
  }[];
  const groups = (groupsRes.data ?? []) as { id: string; name: string; city: string | null; starts_on: string | null; ends_on: string | null; featured_rank: number | null }[];

  const items: Item[] = inDiscoverOrder(
    [
      ...groups.map((g): Item => {
        const members = tournaments.filter((t) => t.event_group_id === g.id);
        return {
          id: g.id,
          kind: "group",
          name: g.name,
          detail: [g.city, g.starts_on && `${g.starts_on}${g.ends_on && g.ends_on !== g.starts_on ? ` – ${g.ends_on}` : ""}`, `${members.length} tournament${members.length === 1 ? "" : "s"}`]
            .filter(Boolean)
            .join(" · "),
          featured: g.featured_rank !== null,
          live: members.some((t) => liveTournaments.has(t.id)),
        };
      }),
      // Tournaments in an event group move with their group; only stand-alone ones are placed on their own.
      ...tournaments
        .filter((t) => !t.event_group_id && t.status === "active")
        .map((t): Item => ({
          id: t.id,
          kind: "tournament",
          name: t.name,
          detail: [t.sport, t.public_access_enabled ? null : "not public"].filter(Boolean).join(" · "),
          featured: false,
          live: liveTournaments.has(t.id),
        })),
    ],
    (x) => [x.id],
    order,
  );
  const position = new Map(order.map((id, i) => [id, i + 1]));

  const storedFlags = (settings.get("flags") ?? {}) as Record<string, unknown>;
  const flags = { ...DEFAULT_FLAGS };
  for (const [k, v] of Object.entries(storedFlags)) if (typeof v === "boolean") flags[k] = v;
  const flagNames = Object.keys(flags).sort();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Discover</h1>
        <p className="text-sm text-muted">What leads the Move Score app, for everyone. Changes reach phones within a minute.</p>
      </div>

      <section className="card space-y-3">
        <h2 className="font-bold">Order of the live courts hero</h2>
        <p className="text-sm text-muted">
          Number the events and tournaments in the order the app should show them; leave a box blank to keep it after the numbered
          ones. A featured event leads Discover. Tournaments inside an event move with their event.
        </p>
        {items.length === 0 ? (
          <p className="text-sm text-muted">No events or active tournaments yet.</p>
        ) : (
          <form action={saveDiscoverOrder} className="space-y-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="w-20 pb-1">Order</th>
                  <th className="pb-1">Event or tournament</th>
                  <th className="w-24 pb-1">Featured</th>
                </tr>
              </thead>
              <tbody>
                {items.map((x) => (
                  <tr key={x.id} className="border-t border-border">
                    <td className="py-1.5">
                      <input type="hidden" name="item" value={x.id} />
                      <input
                        type="number"
                        name={`pos.${x.id}`}
                        min={1}
                        max={999}
                        defaultValue={position.get(x.id) ?? ""}
                        className="input w-16"
                        aria-label={`Order of ${x.name}`}
                      />
                    </td>
                    <td className="py-1.5">
                      <span className="font-semibold">{x.name}</span>{" "}
                      <span className={`badge ml-1 ${x.kind === "group" ? "bg-accent/15 text-accent" : "bg-border text-muted"}`}>
                        {x.kind === "group" ? "event" : "tournament"}
                      </span>
                      {x.live && <span className="badge ml-1 bg-danger/15 text-danger">live</span>}
                      {x.detail && <span className="block text-xs text-muted">{x.detail}</span>}
                    </td>
                    <td className="py-1.5">
                      {x.kind === "group" ? (
                        <input type="checkbox" name="featured" value={x.id} defaultChecked={x.featured} aria-label={`Feature ${x.name}`} />
                      ) : (
                        <span className="text-xs text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn-primary">Save order</button>
          </form>
        )}
      </section>

      <section className="card space-y-3">
        <h2 className="font-bold">App feature flags</h2>
        <p className="text-sm text-muted">
          Switch app features on or off for every phone. A flag the app does not know is ignored by it. Tournament details live on each
          tournament&apos;s <Link className="text-accent underline" href="/admin/tournaments">App tab</Link>.
        </p>
        <StateForm action={saveFlags} className="space-y-2">
          <div className="grid gap-1 sm:grid-cols-2">
            {flagNames.map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input type="checkbox" name={`flag.${k}`} defaultChecked={flags[k] === true} />
                <code>{k}</code>
                {!(k in storedFlags) && <span className="text-xs text-muted">(default)</span>}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label>
              <span className="label">Add a flag</span>
              <input name="new_flag" className="input" placeholder="new_feature" pattern="[a-z][a-z0-9_]{1,39}" />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" name="new_flag_on" /> On</label>
          </div>
          <button className="btn-primary">Save flags</button>
        </StateForm>
      </section>
    </div>
  );
}
