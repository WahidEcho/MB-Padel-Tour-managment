import { notFound } from "next/navigation";
import { db } from "@/lib/supabase";
import { getTournament } from "@/lib/data";
import { requireRole } from "@/lib/guard";
import ConfirmSubmit from "@/components/ConfirmSubmit";
import SessionRowNotice from "../SessionRowNotice";
import { formatAccessCode } from "@/lib/players/accessCode";
import { displayPhone, toE164 } from "@/lib/players/phone";
import { codeEmailSubject, codeMessage, codesCsv, mailtoLink, whatsAppLink } from "@/lib/players/share";
import { CopyButton, CsvTools } from "./CodeTools";
import { fillCodes, resetCode, savePlayerContact } from "./actions";

export const dynamic = "force-dynamic";

interface TeamRow {
  id: string;
  team_name: string;
  nation_code: string | null;
  iso2: string | null;
  phone: string | null;
  seed_number: number | null;
}
interface PlayerRow {
  id: string;
  team_id: string;
  full_name: string;
  player_order: number;
  access_code: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * Player codes: each player's private code, with Copy, WhatsApp, Email and
 * Reset, the player's own phone and email, and every code as CSV. The messaging
 * tools (Announcements) read the same players.access_code column.
 */
export default async function PlayerCodesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireRole(["admin", "manager"], `/admin/tournaments/${id}/players`);
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  if (tournament.kind !== "tournament") return <SessionRowNotice tournamentId={id} tool="Player codes" />;

  const [{ data: teamData }, { data: playerData }] = await Promise.all([
    db().from("teams").select("id, team_name, nation_code, iso2, phone, seed_number").eq("tournament_id", id).order("team_name"),
    db().from("players").select("id, team_id, full_name, player_order, access_code, phone, email").eq("tournament_id", id).order("player_order"),
  ]);
  const teams = (teamData ?? []) as TeamRow[];
  const players = (playerData ?? []) as PlayerRow[];
  const { data: claimData } = players.length
    ? await db().from("player_claims").select("player_id, created_at").in("player_id", players.map((p) => p.id))
    : { data: [] };
  const linkedAt = new Map(((claimData ?? []) as { player_id: string; created_at: string }[]).map((c) => [c.player_id, c.created_at]));
  const sortedTeams = [...teams].sort((a, b) => (a.seed_number ?? 999) - (b.seed_number ?? 999) || a.team_name.localeCompare(b.team_name));
  const missing = players.filter((p) => !p.access_code).length;
  const linked = players.filter((p) => linkedAt.has(p.id)).length;
  const isNations = Boolean(tournament.format_config?.ties);

  const csv = codesCsv(
    sortedTeams.flatMap((t) =>
      players
        .filter((p) => p.team_id === t.id)
        .map((p) => ({ name: p.full_name, team: t.nation_code ? `${t.team_name} (${t.nation_code})` : t.team_name, code: p.access_code, phone: p.phone, email: p.email, linked: linkedAt.has(p.id) })),
    ),
  );

  return (
    <div className="space-y-4">
      <section className="card space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-bold">Player codes ({players.length})</h2>
          <p className="text-xs text-muted">{`${linked} of ${players.length} linked to an app account`}</p>
        </div>
        <p className="text-sm text-muted">
          Each player has a private code. Shared with them on WhatsApp or by email, it lets them sign in to Move Score, enter the code in
          Account and see their matches, and add their photo and phone. One account per player: resetting a code stops the old one and
          unlinks the account. Treat codes like passwords and send each one only to its player.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <CsvTools csv={csv} filename={`${tournament.slug}-player-codes.csv`} />
          {missing > 0 && (
            <form action={fillCodes}>
              <input type="hidden" name="tournament_id" value={id} />
              <button className="btn-secondary text-sm">{`Make codes for ${missing} player${missing === 1 ? "" : "s"} without one`}</button>
            </form>
          )}
        </div>
      </section>

      {sortedTeams.map((t) => {
        const roster = players.filter((p) => p.team_id === t.id);
        if (!roster.length) return null;
        const teamPhone = toE164(t.phone);
        return (
          <section key={t.id} className="card space-y-2" data-testid="player-codes-team">
            <h3 className="flex items-center gap-2 font-bold">
              {t.iso2 && /^[a-z]{2}$/.test(t.iso2) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/flags/${t.iso2}.svg`} alt="" className="h-4 w-6 rounded-sm object-cover" />
              ) : null}
              {t.team_name}
              {t.nation_code && <span className="font-mono text-xs text-muted">{t.nation_code}</span>}
            </h3>
            <div className="space-y-2">
              {roster.map((p) => {
                const code = p.access_code;
                const message = code ? codeMessage({ playerName: p.full_name, tournamentName: tournament.name, code }) : "";
                const waTo = p.phone ?? teamPhone;
                const when = linkedAt.get(p.id);
                return (
                  <div key={p.id} className="space-y-2 rounded-xl border border-border p-3" data-testid="player-code-row">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold">{p.full_name}</p>
                        <p className="text-xs text-muted">
                          {when ? (
                            <span className="badge mr-1 bg-accent/15 text-accent">Linked · {new Date(when).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                          ) : (
                            <span className="badge mr-1 bg-border text-muted">Not linked</span>
                          )}
                          {isNations && p.player_order === 4 ? "Reserve" : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="rounded-lg bg-background px-3 py-1.5 font-mono text-base font-bold tracking-widest" data-testid="player-code">
                          {code ? formatAccessCode(code) : "—"}
                        </code>
                        {code && <CopyButton text={formatAccessCode(code)} />}
                        {code && (
                          <a
                            className="btn-secondary text-xs"
                            href={whatsAppLink(waTo, message)}
                            target="_blank"
                            rel="noreferrer"
                            title={waTo ? `WhatsApp ${displayPhone(waTo)}${p.phone ? "" : " (team contact)"}` : "WhatsApp: choose the chat"}
                          >
                            Share on WhatsApp{waTo && !p.phone ? " (team)" : ""}
                          </a>
                        )}
                        {code && (
                          <a className="btn-secondary text-xs" href={mailtoLink(p.email, codeEmailSubject(tournament.name), message)}>
                            Email
                          </a>
                        )}
                        <form action={resetCode}>
                          <input type="hidden" name="tournament_id" value={id} />
                          <input type="hidden" name="player_id" value={p.id} />
                          <ConfirmSubmit
                            className="btn-secondary text-xs text-danger"
                            message={`Reset ${p.full_name}'s code? The old code stops working${when ? " and their app account is unlinked" : ""}.`}
                          >
                            Reset code
                          </ConfirmSubmit>
                        </form>
                      </div>
                    </div>
                    <form action={savePlayerContact} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="tournament_id" value={id} />
                      <input type="hidden" name="player_id" value={p.id} />
                      <label className="min-w-40 flex-1">
                        <span className="label">Player phone</span>
                        <input name="phone" defaultValue={p.phone ?? ""} className="input" placeholder={teamPhone ? `Team: ${displayPhone(teamPhone)}` : "0100 123 4567 or +44…"} inputMode="tel" />
                      </label>
                      <label className="min-w-48 flex-1">
                        <span className="label">Player email</span>
                        <input name="email" type="email" defaultValue={p.email ?? ""} className="input" placeholder="name@example.com" />
                      </label>
                      <button className="btn-secondary text-xs">Save contact</button>
                    </form>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
      {players.length === 0 && <p className="card text-sm text-muted">No players yet. Add {isNations ? "nations" : "teams"} first; every new player gets a code.</p>}
    </div>
  );
}
