/**
 * "N watching" — a heartbeat from a browser on a public page.
 *
 * The second-least trusted endpoint in the app after public registration, so it
 * is built to be boring under abuse:
 *  - the caller sends a slug and a short page enum, never a storage key, so the
 *    key is always composed server-side and nobody can write into another
 *    tournament's count or invent unbounded keys;
 *  - the tournament must exist and be public, or nothing is written;
 *  - the visitor id must be the uuid shape this app issues, which bounds the
 *    column and means a scripted caller has to work to inflate the number;
 *  - one row per (page, browser), so repeated beats update rather than insert:
 *    the table's size is bounded by real visitors, not by request volume;
 *  - the endpoint sweeps its own stale rows, because nothing schedules jobs here.
 *
 * It answers with the count so the browser gets the figure on the same round
 * trip. No rate limiter: the limiter itself writes a row per call, so throttling
 * a 20-second heartbeat would add more database work than it saves, and the
 * bounds above already cap the damage.
 */
import { NextResponse, after } from "next/server";
import { db } from "@/lib/supabase";
import {
  LIVE_WINDOW_SECONDS,
  SWEEP_AFTER_SECONDS,
  isPresencePage,
  isVisitorId,
  presenceKey,
} from "@/lib/presence";

/** A beat carries four short fields; anything larger is not one of ours. */
const MAX_BODY_BYTES = 512;

/** Roughly one beat in twenty-five pays for the housekeeping. */
const SWEEP_CHANCE = 0.04;

/** Never an error: a cosmetic counter must not make a page look broken. */
const SILENT = { watching: 0 };

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json(SILENT);

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return NextResponse.json(SILENT);
  }

  const slug = typeof body.slug === "string" ? body.slug.slice(0, 120) : "";
  const page = body.page;
  const visitorId = body.visitorId;
  const isSession = body.kind === "session";
  if (!slug || !isPresencePage(page) || !isVisitorId(visitorId)) return NextResponse.json(SILENT);

  // Resolve the tournament ourselves. A friendly session owns a hidden backing
  // tournament, so both kinds of public page end up keyed the same way.
  const tournamentId = isSession ? await sessionTournamentId(slug) : await publicTournamentId(slug);
  if (!tournamentId) return NextResponse.json(SILENT);

  const key = presenceKey(tournamentId, page);
  const now = new Date();

  const { error } = await db()
    .from("page_presence")
    .upsert(
      { page_key: key, visitor_id: visitorId, last_seen: now.toISOString() },
      { onConflict: "page_key,visitor_id" },
    );
  // A failed write is reported as zero rather than as an error: the page is
  // fine, only the number is missing.
  if (error) return NextResponse.json(SILENT);

  const since = new Date(now.getTime() - LIVE_WINDOW_SECONDS * 1000).toISOString();
  const { count } = await db()
    .from("page_presence")
    .select("visitor_id", { count: "exact", head: true })
    .eq("page_key", key)
    .gt("last_seen", since);

  // Housekeeping after the response is sent, so it never adds latency to a beat.
  //
  // The callback form matters. `after()` treats a thenable and a function
  // differently (next/dist/server/after/after-context.js): a promise is handed
  // straight to waitUntil — and calling sweep() to produce one has already
  // started the query — while a function is queued and drained when the response
  // closes. `after(sweep())` would have run the delete alongside the response.
  if (Math.random() < SWEEP_CHANCE) {
    after(() => sweep());
  }

  return NextResponse.json({ watching: count ?? 0 });
}

/** A public tournament's id, or null when it does not exist or is not public. */
async function publicTournamentId(slug: string): Promise<string | null> {
  const { data } = await db()
    .from("tournaments")
    .select("id, public_access_enabled")
    .eq("slug", slug)
    .maybeSingle();
  const row = data as { id: string; public_access_enabled: boolean } | null;
  return row?.public_access_enabled ? row.id : null;
}

/** A public session's backing tournament id. */
async function sessionTournamentId(slug: string): Promise<string | null> {
  const { data } = await db()
    .from("friendly_sessions")
    .select("tournament_id, visibility")
    .eq("slug", slug)
    .maybeSingle();
  const row = data as { tournament_id: string; visibility: string } | null;
  return row?.visibility === "public" ? row.tournament_id : null;
}

/**
 * Deletes rows that stopped counting minutes ago.
 *
 * Swept from the request path on purpose. `pruneRateLimitCounters` in
 * src/lib/ratelimit.ts is the cautionary tale: a correct housekeeping function
 * that nothing ever calls, so the table it tidies has never been tidied. Doing
 * it here means the table cannot grow without something also cleaning it.
 */
async function sweep(): Promise<void> {
  const cutoff = new Date(Date.now() - SWEEP_AFTER_SECONDS * 1000).toISOString();
  await db().from("page_presence").delete().lt("last_seen", cutoff);
}
