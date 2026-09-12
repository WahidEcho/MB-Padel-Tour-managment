import ExcelJS from "exceljs";
import { currentRole, can } from "@/lib/auth";
import {
  getBracket,
  getBrackets,
  getBracketSlots,
  getCourts,
  getGroups,
  getGroupTeams,
  getMatches,
  getSnapshots,
  getStandings,
  getTeams,
  getTournament,
  teamMap,
} from "@/lib/data";
import { db } from "@/lib/supabase";
import { podiumFromMatches } from "@/components/WinnerDisplay";
import { podiumDepthFor } from "@/lib/bracket";
import { audit, slugify } from "@/lib/audit";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const role = await currentRole();
  if (!can(role, "export")) {
    return new Response("Not allowed", { status: 403 });
  }
  const { id } = await params;
  const tournament = await getTournament(id);
  if (!tournament) return new Response("Not found", { status: 404 });

  const [teams, groups, groupTeams, matches, snapshots, standings, courts] = await Promise.all([
    getTeams(id),
    getGroups(id),
    getGroupTeams(id),
    getMatches(id),
    getSnapshots(id),
    getStandings(id),
    getCourts(id),
  ]);
  const tm = teamMap(teams);
  const snapByMatch = new Map(snapshots.map((s) => [s.match_id, s]));
  const groupNames = new Map(groups.map((g) => [g.id, g.group_name]));
  const courtNames = new Map(courts.map((c) => [c.id, c.court_name]));
  const teamName = (teamId: string | null) => (teamId ? tm.get(teamId)?.team_name ?? "?" : "TBD");

  const wb = new ExcelJS.Workbook();
  wb.creator = "Move Beyond Tournament Management";

  const summary = wb.addWorksheet("Tournament Summary");
  // One podium per bracket: a Cup and a Plate each crown their own champion.
  const brackets = await getBrackets(tournament.id);
  const podiums = (brackets.length > 0 ? brackets : [null]).map((bracket) => ({
    label: bracket ? (bracket.tier === "plate" ? "Plate" : "Cup") : "Cup",
    podium: podiumFromMatches(matches, tm, {
      tier: bracket?.tier ?? "cup",
      bracketId: bracket?.id ?? undefined,
      depth: podiumDepthFor(tournament.format_config, bracket?.tier ?? "cup"),
    }),
  }));
  const placeName = (label: string, place: number) =>
    (podiums.find((p) => p.label === label)?.podium.places.find((x) => x.place === place)?.team?.team_name) ?? "—";
  summary.addRows([
    ["Tournament", tournament.name],
    ["Status", tournament.status],
    ["Sport", tournament.sport],
    ["Public link", `/t/${tournament.slug}`],
    ["Teams", teams.length],
    ["Groups", groups.length],
    ["Matches", matches.length],
    ["Champion", placeName("Cup", 1)],
    ["Runner-up", placeName("Cup", 2)],
    ["Third place", placeName("Cup", 3)],
    ...(podiums.some((p) => p.label === "Plate")
      ? [
          ["Plate champion", placeName("Plate", 1)],
          ["Plate runner-up", placeName("Plate", 2)],
        ]
      : []),
    ["Exported at", new Date().toISOString()],
  ]);
  summary.getColumn(1).width = 22;
  summary.getColumn(2).width = 40;

  const teamsSheet = wb.addWorksheet("Teams");
  teamsSheet.addRow(["Team", "Player 1", "Player 2", "Phone", "Check-in", "Status", "Notes"]);
  for (const t of teams) {
    teamsSheet.addRow([
      t.team_name,
      t.players?.[0]?.full_name ?? "",
      t.players?.[1]?.full_name ?? "",
      t.phone ?? "",
      t.check_in_status,
      t.team_status,
      t.notes ?? "",
    ]);
  }

  const playersSheet = wb.addWorksheet("Players");
  playersSheet.addRow(["Player", "Team", "Photo URL"]);
  for (const t of teams) {
    for (const p of t.players ?? []) playersSheet.addRow([p.full_name, t.team_name, p.photo_url ?? ""]);
  }

  const groupsSheet = wb.addWorksheet("Groups");
  groupsSheet.addRow(["Group", "Position", "Team"]);
  for (const gt of groupTeams) {
    groupsSheet.addRow([groupNames.get(gt.group_id) ?? "?", gt.position, teamName(gt.team_id)]);
  }

  const matchesSheet = wb.addWorksheet("Group Matches");
  matchesSheet.addRow(["#", "Round", "Team A", "Team B", "Court", "Status", "Score", "Winner"]);
  for (const m of matches.filter((m) => m.stage === "group")) {
    const snap = snapByMatch.get(m.id);
    const sets = (snap?.completed_sets ?? []).map((s) => `${s.teamAGames}-${s.teamBGames}`).join(" ");
    matchesSheet.addRow([
      m.match_order,
      m.round_name,
      teamName(m.team_a_id),
      teamName(m.team_b_id),
      m.court_id ? courtNames.get(m.court_id) : "",
      m.status,
      sets || (snap ? `${snap.team_a_games}-${snap.team_b_games}` : ""),
      m.winner_team_id ? teamName(m.winner_team_id) : "",
    ]);
  }

  const lbSheet = wb.addWorksheet("Leaderboard");
  lbSheet.addRow(["Group", "Rank", "Team", "Played", "Won", "Lost", "Points", "Sets W-L", "Set diff", "Games W-L", "Game diff", "Status"]);
  for (const s of standings) {
    lbSheet.addRow([
      groupNames.get(s.group_id) ?? "?",
      s.rank,
      teamName(s.team_id),
      s.played,
      s.won,
      s.lost,
      s.points,
      `${s.sets_won}-${s.sets_lost}`,
      s.set_diff,
      `${s.games_won}-${s.games_lost}`,
      s.game_diff,
      s.status,
    ]);
  }

  const bracket = await getBracket(id);
  const bracketSheet = wb.addWorksheet("Knockout Bracket");
  bracketSheet.addRow(["Round", "Slot", "Team", "Bye", "Match", "Match status", "Winner"]);
  if (bracket) {
    const slots = await getBracketSlots(bracket.id);
    const matchById = new Map(matches.map((m) => [m.id, m]));
    for (const s of slots) {
      const m = s.match_id ? matchById.get(s.match_id) : null;
      bracketSheet.addRow([
        s.round_name,
        s.slot_order + 1,
        s.is_bye ? "BYE" : teamName(s.team_id),
        s.is_bye ? "yes" : "",
        m?.round_name ?? "",
        m?.status ?? "",
        m?.winner_team_id ? teamName(m.winner_team_id) : "",
      ]);
    }
  }

  const finalSheet = wb.addWorksheet("Final Results");
  for (const { label, podium } of podiums) {
    finalSheet.addRow([label]);
    for (const place of podium.places) {
      finalSheet.addRow([
        ["", "Champion", "Runner-up", "Third place", "Fourth place"][place.place],
        place.team?.team_name ?? "—",
      ]);
    }
    if (podium.places.length === 0) finalSheet.addRow(["Not finished", "—"]);
    finalSheet.addRow([]);
  }

  const auditSheet = wb.addWorksheet("Audit Summary");
  auditSheet.addRow(["Time", "Role", "Action", "Entity", "Details"]);
  const { data: logs } = await db()
    .from("audit_logs")
    .select("*")
    .eq("tournament_id", id)
    .order("created_at", { ascending: false })
    .limit(500);
  for (const log of logs ?? []) {
    auditSheet.addRow([
      log.created_at,
      log.actor_role ?? "",
      log.action,
      log.entity_type ?? "",
      log.new_value ? JSON.stringify(log.new_value) : "",
    ]);
  }

  for (const ws of wb.worksheets) {
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((col) => {
      if (!col.width) col.width = 18;
    });
  }

  await audit({ tournament_id: id, actor_role: role, action: "EXCEL_EXPORTED" });
  const buffer = await wb.xlsx.writeBuffer();
  return new Response(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${slugify(tournament.name)}-results.xlsx"`,
    },
  });
}
