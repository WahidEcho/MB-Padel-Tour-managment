/** Audience shapes and what each can be reached by. Pure module (the composer imports it). */

export type Audience =
  | { type: "all_players" }
  | { type: "tournament"; tournamentId: string }
  | { type: "nation"; nationCode: string }
  | { type: "app_users" }
  | { type: "list"; list: string };

export const AUDIENCE_LABEL: Record<Audience["type"], string> = {
  all_players: "All players on the platform",
  tournament: "Players of a tournament",
  nation: "Players of a nation",
  app_users: "Move Score app users",
  list: "Pasted list",
};

export function parseAudience(raw: unknown): Audience {
  const a = (raw ?? {}) as Record<string, unknown>;
  switch (a.type) {
    case "tournament":
      if (typeof a.tournamentId !== "string" || !a.tournamentId) throw new Error("Pick a tournament");
      return { type: "tournament", tournamentId: a.tournamentId };
    case "nation": {
      const code = String(a.nationCode ?? "").trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) throw new Error("Pick a nation");
      return { type: "nation", nationCode: code };
    }
    case "app_users":
      return { type: "app_users" };
    case "list":
      return { type: "list", list: String(a.list ?? "").slice(0, 200_000) };
    case "all_players":
      return { type: "all_players" };
    default:
      throw new Error("Pick an audience");
  }
}

/** Which channels make sense for an audience. */
export function channelsFor(a: Audience["type"]): { email: boolean; whatsapp: boolean; push: boolean } {
  switch (a) {
    case "app_users":
      return { email: false, whatsapp: false, push: true };
    case "tournament":
    case "nation":
      return { email: true, whatsapp: true, push: true };
    default:
      return { email: true, whatsapp: true, push: false };
  }
}
