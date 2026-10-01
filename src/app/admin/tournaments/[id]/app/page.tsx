import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { getTeams, getTournament } from "@/lib/data";
import { requireRole } from "@/lib/guard";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import { deleteAnnouncement, makeClaimCodes, postAnnouncement, saveAppSettings, saveEventGroup } from "./actions";

export const dynamic = "force-dynamic";

interface GroupRow {
  id: string;
  slug: string;
  name: string;
  subtitle: string | null;
  venue_name: string | null;
  city: string | null;
  country_code: string | null;
  timezone: string;
  starts_on: string | null;
  ends_on: string | null;
  artwork_url: string | null;
  featured_rank: number | null;
}

export default async function AppSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireRole(["admin", "manager"], `/admin/tournaments/${id}/app`);
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const [{ data: groups }, { data: ann }, teams, { data: codesRow }] = await Promise.all([
    db().from("event_groups").select("*").order("created_at", { ascending: false }),
    db().from("announcements").select("id, title, body, level, published_at, tournament_id").or(`tournament_id.eq.${id}${tournament.event_group_id ? `,event_group_id.eq.${tournament.event_group_id}` : ""}`).order("published_at", { ascending: false }).limit(20),
    getTeams(id),
    db().from("platform_settings").select("value_json").eq("key", `claim-codes:${id}`).maybeSingle(),
  ]);
  const allGroups = (groups ?? []) as GroupRow[];
  const group = allGroups.find((g) => g.id === tournament.event_group_id) ?? null;
  const skin = tournament.app_skin ?? {};
  // Freshly issued player codes are shown once, then forgotten.
  const issued = (codesRow as { value_json?: { at: number; codes: { player_id: string; code: string }[] } } | null)?.value_json;
  if (issued) await db().from("platform_settings").delete().eq("key", `claim-codes:${id}`);
  const playerName = new Map(teams.flatMap((t) => (t.players ?? []).map((p) => [p.id, `${p.full_name} · ${t.nation_code ?? t.team_name}`] as const)));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="card space-y-3">
        <h2 className="font-bold">In the Move Score app</h2>
        <p className="text-sm text-muted">
          Where and when the tournament is played, and how it looks in the app. Two tournaments played side by side belong in one event
          group, which the app shows as a single event.
        </p>
        <form action={saveAppSettings} className="grid grid-cols-2 gap-2">
          <input type="hidden" name="tournament_id" value={id} />
          <label className="col-span-2">
            <span className="label">Event group</span>
            <select name="event_group_id" defaultValue={tournament.event_group_id ?? ""} className="input">
              <option value="">None</option>
              {allGroups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </label>
          <label className="col-span-2">
            <span className="label">Or start a new event group</span>
            <input name="new_group_name" className="input" placeholder="Junior Team Finals 2026" />
          </label>
          <label className="col-span-2"><span className="label">Venue</span><input name="venue_name" defaultValue={tournament.venue_name ?? ""} className="input" placeholder="Smash Sporting Club" /></label>
          <label><span className="label">City</span><input name="city" defaultValue={tournament.city ?? ""} className="input" placeholder="Cairo" /></label>
          <label><span className="label">Country (2 letters)</span><input name="country_code" defaultValue={tournament.country_code ?? ""} className="input" placeholder="EG" maxLength={2} /></label>
          <label><span className="label">First day</span><input type="date" name="starts_on" defaultValue={tournament.starts_on ?? ""} className="input" /></label>
          <label><span className="label">Last day</span><input type="date" name="ends_on" defaultValue={tournament.ends_on ?? ""} className="input" /></label>
          <label className="col-span-2"><span className="label">Time zone</span><input name="timezone" defaultValue={tournament.timezone ?? "Africa/Cairo"} className="input" /></label>
          <label><span className="label">Skin colour 1</span><input type="color" name="seed_a" defaultValue={skin.seedA ?? "#1e6bff"} className="input h-10 p-1" /></label>
          <label><span className="label">Skin colour 2</span><input type="color" name="seed_b" defaultValue={skin.seedB ?? "#fcfc00"} className="input h-10 p-1" /></label>
          <label>
            <span className="label">Preferred look</span>
            <select name="skin_mode" defaultValue={skin.mode ?? ""} className="input">
              <option value="">Follow the phone</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" name="show_photos" defaultChecked={skin.showPhotos === true} /> Show player photos</label>
          <label className="col-span-2"><span className="label">Hero artwork URL</span><input name="artwork_url" defaultValue={skin.artworkUrl ?? ""} className="input" /></label>
          <button className="btn-primary col-span-2">Save</button>
        </form>
      </section>

      {group && (
        <section className="card space-y-3">
          <h2 className="font-bold">Event: {group.name}</h2>
          <p className="text-sm text-muted">
            Featured events lead Discover in the app. Gate code page:{" "}
            <Link className="text-accent underline" href={`/venue/${group.slug}/qr`}>/venue/{group.slug}/qr</Link>
          </p>
          <form action={saveEventGroup} className="grid grid-cols-2 gap-2">
            <input type="hidden" name="tournament_id" value={id} />
            <input type="hidden" name="group_id" value={group.id} />
            <label className="col-span-2"><span className="label">Name</span><input name="name" defaultValue={group.name} className="input" /></label>
            <label className="col-span-2"><span className="label">Subtitle</span><input name="subtitle" defaultValue={group.subtitle ?? ""} className="input" placeholder="Davis Cup and Billie Jean King Cup Junior Finals" /></label>
            <label className="col-span-2"><span className="label">Venue</span><input name="venue_name" defaultValue={group.venue_name ?? ""} className="input" /></label>
            <label><span className="label">City</span><input name="city" defaultValue={group.city ?? ""} className="input" /></label>
            <label><span className="label">Country (2 letters)</span><input name="country_code" defaultValue={group.country_code ?? ""} className="input" maxLength={2} /></label>
            <label><span className="label">First day</span><input type="date" name="starts_on" defaultValue={group.starts_on ?? ""} className="input" /></label>
            <label><span className="label">Last day</span><input type="date" name="ends_on" defaultValue={group.ends_on ?? ""} className="input" /></label>
            <label><span className="label">Time zone</span><input name="timezone" defaultValue={group.timezone} className="input" /></label>
            <label><span className="label">Featured order (blank = not featured)</span><input name="featured_rank" type="number" min={0} max={99} defaultValue={group.featured_rank ?? ""} className="input" /></label>
            <label className="col-span-2"><span className="label">Artwork URL</span><input name="artwork_url" defaultValue={group.artwork_url ?? ""} className="input" /></label>
            <button className="btn-primary col-span-2">Save event</button>
          </form>
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="font-bold">Announcements</h2>
        <p className="text-sm text-muted">Major announcements are pushed to everyone following the event. Use them sparingly: the start, the final, a rain delay.</p>
        <form action={postAnnouncement} className="space-y-2">
          <input type="hidden" name="tournament_id" value={id} />
          <input name="title" required maxLength={120} className="input" placeholder="Semi-finals start at 10:00" />
          <textarea name="body" maxLength={600} className="input" rows={2} placeholder="Optional detail" />
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1"><input type="radio" name="level" value="info" defaultChecked /> In the app only</label>
            <label className="flex items-center gap-1"><input type="radio" name="level" value="major" /> Push to followers</label>
            {group && <label className="flex items-center gap-1"><input type="checkbox" name="scope" value="group" /> Whole event ({group.name})</label>}
          </div>
          <button className="btn-primary">Post</button>
        </form>
        <ul className="space-y-1">
          {((ann ?? []) as { id: string; title: string; level: string; published_at: string }[]).map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 rounded-lg bg-background px-3 py-2 text-sm">
              <span><span className={`badge mr-2 ${a.level === "major" ? "bg-accent/15 text-accent" : "bg-border text-muted"}`}>{a.level}</span>{a.title}</span>
              <form action={deleteAnnouncement}>
                <input type="hidden" name="tournament_id" value={id} />
                <input type="hidden" name="announcement_id" value={a.id} />
                <ConfirmSubmit className="text-xs text-danger" message="Remove this announcement from the app?">Remove</ConfirmSubmit>
              </form>
            </li>
          ))}
        </ul>
      </section>

      <section className="card space-y-3">
        <h2 className="font-bold">Player codes</h2>
        <p className="text-sm text-muted">
          One-time codes that let a player link their account to their profile. Switched off in the app for the Junior Finals; issue
          codes only for an adult event. Issuing again cancels any unused codes.
        </p>
        <form action={makeClaimCodes}>
          <input type="hidden" name="tournament_id" value={id} />
          <ConfirmSubmit className="btn-secondary" message="Issue a new code for every player? Unused codes stop working.">Issue codes for all players</ConfirmSubmit>
        </form>
        {issued && (
          <div className="space-y-1">
            <p className="text-sm font-semibold text-warning">Copy these now. They are not shown again.</p>
            <ul className="max-h-72 overflow-auto rounded-lg bg-background p-2 font-mono text-xs">
              {issued.codes.map((c) => (
                <li key={c.player_id}>{c.code} · {playerName.get(c.player_id) ?? c.player_id}</li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
