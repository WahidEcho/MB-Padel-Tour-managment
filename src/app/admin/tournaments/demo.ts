"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/supabase";
import { requirePermission } from "@/lib/guard";
import { audit, slugify } from "@/lib/audit";
import { generateDraw, groupName } from "@/lib/draws";
import { generateGroupMatches, recalcStandings } from "@/lib/ops";
import { DEFAULT_SCORING_CONFIG } from "@/lib/types";
import { ensureMainScreen } from "@/lib/screens";

const DEMO_TEAMS: [string, string, string][] = [
  ["Team Alpha", "Ahmed Ali", "Omar Khaled"],
  ["Team Bravo", "Mohamed Samir", "Youssef Hany"],
  ["Team Comet", "Karim Adel", "Hassan Tarek"],
  ["Team Delta", "Mostafa Nour", "Ali Sherif"],
  ["Team Eagle", "Tamer Fawzy", "Ziad Amr"],
  ["Team Falcon", "Sherif Gamal", "Hany Sami"],
  ["Team Gravity", "Amr Salah", "Walid Fathy"],
  ["Team Horizon", "Khaled Mounir", "Seif Hossam"],
  ["Team Impact", "Nader Ashraf", "Ramy Ehab"],
  ["Team Jaguar", "Hossam Adham", "Fady Maged"],
  ["Team Krypton", "Mido Yasser", "Shady Kamal"],
  ["Team Lunar", "Bassem Raouf", "Wael Magdy"],
];

/** Seeds a complete 12-team demo tournament for training and screen testing (spec §24). */
export async function seedDemoTournament() {
  const role = await requirePermission("manage_tournament");
  const name = "Demo Tournament";
  const slug = `${slugify(name)}-${Math.random().toString(36).slice(2, 6)}`;

  const { data: tournament, error } = await db()
    .from("tournaments")
    .insert({
      name,
      slug,
      is_demo: true,
      status: "active",
      scoring_config: DEFAULT_SCORING_CONFIG,
      created_by: role,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  const id = tournament.id as string;

  await db().from("courts").insert([
    { tournament_id: id, court_name: "Court 1", court_order: 1 },
    { tournament_id: id, court_name: "Court 2", court_order: 2 },
  ]);
  await ensureMainScreen(id);

  const teamIds: string[] = [];
  for (const [teamName, p1, p2] of DEMO_TEAMS) {
    const { data: team } = await db()
      .from("teams")
      .insert({ tournament_id: id, team_name: teamName, check_in_status: "checked_in" })
      .select()
      .single();
    if (!team) continue;
    teamIds.push(team.id);
    await db().from("players").insert([
      { tournament_id: id, team_id: team.id, player_order: 1, full_name: p1 },
      { tournament_id: id, team_id: team.id, player_order: 2, full_name: p2 },
    ]);
  }

  const groupRows = Array.from({ length: 4 }, (_, i) => ({
    tournament_id: id,
    group_name: groupName(i),
    group_order: i + 1,
    status: "published",
  }));
  const { data: groups } = await db().from("groups").insert(groupRows).select();
  const draw = generateDraw(teamIds, 4);
  const gtRows = draw.groups.flatMap((ids, gi) =>
    ids.map((teamId, pos) => ({
      tournament_id: id,
      group_id: groups![gi].id,
      team_id: teamId,
      position: pos + 1,
    }))
  );
  await db().from("group_teams").insert(gtRows);
  await generateGroupMatches(id, role);
  await recalcStandings(id);

  await audit({ tournament_id: id, actor_role: role, action: "DEMO_TOURNAMENT_SEEDED" });
  redirect(`/admin/tournaments/${id}`);
}
