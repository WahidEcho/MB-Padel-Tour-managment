/**
 * Loads the nations and finals demo events into the local stand-in as one
 * featured event, with three rubbers part-way through, so the Move Score app has
 * something live to show. Local only: it refuses any other database.
 *
 *   npm run localdb                                    # terminal 1
 *   npx next start -p 3077 (with .env.localdb)         # terminal 2
 *   npx tsx --env-file=.env.localdb scripts/localdb/seed-app-demo.ts
 */
import { execFileSync } from "child_process";
import { openDriver, point } from "../e2e/lib/driver";

const DB = process.env.SUPABASE_URL ?? "";
if (!/localhost|127\.0\.0\.1/.test(DB)) throw new Error("seed-app-demo only runs against the local stand-in");

async function sql(query: string) {
  const res = await fetch(`${DB}/__sql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
  return res.json();
}

async function main() {
  for (const d of ["team", "finals"]) {
    const text = execFileSync("npx", ["tsx", `scripts/demo/${d}-demo.ts`], { encoding: "utf8" });
    await sql(text);
  }
  await sql(`
    insert into event_groups (slug, name, subtitle, venue_name, city, timezone, starts_on, ends_on, featured_rank)
    values ('junior-team-finals-2026', 'Junior Team Finals 2026', 'Sample event · tennis nations team competition', 'Smash Sporting Club', 'Cairo', 'Africa/Cairo', current_date - 2, current_date + 4, 1)
    on conflict (slug) do nothing;
    update tournaments set is_demo = false, event_group_id = (select id from event_groups where slug = 'junior-team-finals-2026'),
      venue_name = 'Smash Sporting Club', city = 'Cairo', starts_on = current_date - 2, ends_on = current_date + 4,
      app_skin = case when slug = 'junior-team-finals-nations-demo' then '{"seedA":"#8a4fff","seedB":"#3ddc97"}'::jsonb else '{"seedA":"#d8572a","seedB":"#fcfc00"}'::jsonb end
    where slug in ('junior-team-finals-nations-demo', 'junior-team-finals-replay-demo');
  `);
  const rows = (await sql(`select m.id from matches m join tournaments t on t.id = m.tournament_id where t.slug = 'junior-team-finals-nations-demo' and m.team_a_player_ids is not null order by m.match_order limit 4`)) as { id: string }[];
  const plans = ["AAAABBBBAAAAAABAAAABBAABAAAAABBBAAAABBBBBAABAAAAABBBBAAAAABAAAABBBBAAAAABABAA", "", "AABBAAAABBBBAAABBAA", "AAAABBBBBBBBAAAABBAAAABBBBAAABBBBAAAABBBBAABB"];
  for (let i = 0; i < rows.length; i++) {
    if (!plans[i]) continue;
    const d = await openDriver(rows[i]!.id, "seed-phone");
    for (const c of plans[i]!) await point(d, c as "A" | "B");
    await sql(`update matches set status = 'live', started_at = now() where id = '${rows[i]!.id}'; update ties set status = 'live' where id = (select tie_id from matches where id = '${rows[i]!.id}');`);
    console.log("live", rows[i]!.id, d.eventNumber, "events");
  }
}

void main();
