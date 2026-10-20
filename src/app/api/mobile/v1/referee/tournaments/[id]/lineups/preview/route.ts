import { staffRoute } from "@/lib/guard";
import { privateJson } from "@/lib/mobile/http";
import { lineupActor } from "@/lib/tennis/lineupServer";
import { readSheet, previewSheet } from "@/lib/tennis/lineupSheet";
import { WorkbookTooBig, readWorkbook, sheetTies, sheetTournaments } from "@/lib/tennis/lineupSheetServer";

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Reads an uploaded line-up sheet and answers the preview: every row matched to its
 * tie, every name to that nation's squad (exact, close with suggestions, unknown),
 * with the ties' squads and current line-ups so the page can re-check a row live.
 * Nothing is saved here (POST …/lineups/apply does it). Organiser and master referees.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await staffRoute("score_match", { tournament: id });
  if (!gate.ok) return gate.response;
  const actor = lineupActor(gate.staff);
  if (!actor || actor.kind === "court") return privateJson({ error: "The line-up sheet is for the organiser and the master referees.", code: "not_allowed" }, 403);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return privateJson({ error: "Choose the filled-in sheet (.xlsx).", code: "no_file" }, 400);
  if (file.size > MAX_BYTES) return privateJson({ error: "That file is too big for a line-up sheet (2 MB at most).", code: "too_big" }, 400);
  let grid: (string | null)[][];
  try {
    grid = await readWorkbook(await file.arrayBuffer());
  } catch (err) {
    if (err instanceof WorkbookTooBig && err.reason === "too_big") {
      return privateJson({ error: "That workbook unpacks to too much for a line-up sheet (20 MB at most). Download the template and fill it in.", code: "too_big" }, 400);
    }
    return privateJson({ error: "That file could not be read as an Excel workbook (.xlsx). Download the template and fill it in.", code: "unreadable" }, 400);
  }
  const sheet = readSheet(grid);
  if (sheet.error) return privateJson({ error: sheet.error, code: "bad_sheet" }, 400);
  const ties = await sheetTies(await sheetTournaments(gate.staff, id));
  const rows = previewSheet(sheet.rows, ties);
  const used = new Set(rows.map((r) => r.tie?.id).filter(Boolean));
  return privateJson({ rows, ties: ties.filter((t) => used.has(t.id)) });
}
