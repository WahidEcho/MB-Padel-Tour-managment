export const CSV_TEMPLATE = `team_name,player_1_name,player_2_name,player_1_photo_url,player_2_photo_url,phone,notes
Team Alpha,Ahmed Ali,Omar Khaled,,,01000000000,
Team Bravo,Mohamed Samir,Youssef Hany,,,01000000001,
`;

export interface CsvTeamRow {
  team_name: string;
  player_1_name: string;
  player_2_name: string;
  player_1_photo_url: string;
  player_2_photo_url: string;
  phone: string;
  notes: string;
  errors: string[];
}

function parseLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function isValidUrl(value: string): boolean {
  if (!value) return true;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function parseTeamsCsv(content: string): CsvTeamRow[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const header = parseLine(lines[0]).map((h) => h.toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const rows: CsvTeamRow[] = [];

  for (const line of lines.slice(1)) {
    const cells = parseLine(line);
    const get = (name: string) => {
      const i = col(name);
      return i >= 0 ? (cells[i] ?? "") : "";
    };
    const row: CsvTeamRow = {
      team_name: get("team_name"),
      player_1_name: get("player_1_name"),
      player_2_name: get("player_2_name"),
      player_1_photo_url: get("player_1_photo_url"),
      player_2_photo_url: get("player_2_photo_url"),
      phone: get("phone"),
      notes: get("notes"),
      errors: [],
    };
    if (!row.team_name) row.errors.push("team_name is required");
    if (!row.player_1_name) row.errors.push("player_1_name is required");
    if (!row.player_2_name) row.errors.push("player_2_name is required");
    // Invalid photo URLs don't block the row — the photo is just ignored (spec §7.6)
    if (!isValidUrl(row.player_1_photo_url)) row.player_1_photo_url = "";
    if (!isValidUrl(row.player_2_photo_url)) row.player_2_photo_url = "";
    rows.push(row);
  }
  return rows;
}
