/**
 * Player codes left in clear in the message log (message_deliveries) by code that
 * ran before Phase 1: the announcement queue stored each recipient's code in
 * `vars.code`; "Send code" stored it in `vars.code`, in the rendered message
 * (`payload`) and in its idempotency key (`player-code:<player>:<channel>:<CODE>:<minute>`).
 * The drain no longer reads `vars.code` (it reads `code_ref`, the player row);
 * scripts/ops/scrub-delivery-codes.ts removes what is left with `scrubDeliveryRow`.
 *
 * Pure module (no database): what one stored row becomes, or null when it holds no code.
 */
import { formatAccessCode, isValidAccessCode, normalizeAccessCode } from "../players/accessCode";

export interface StoredDelivery {
  id: string;
  announcement_id: string | null;
  purpose: string | null;
  status: string;
  recipient_kind: string | null;
  recipient_id: string | null;
  vars: Record<string, unknown> | null;
  payload: unknown;
  idempotency_key: string | null;
}

export interface DeliveryScrub {
  vars?: Record<string, unknown>;
  payload?: unknown;
  idempotency_key?: string;
  /** A send-now row still waiting with the code taken out of its message: it must not go out as "[removed]". */
  status?: "failed";
  error_code?: string;
  error_reason?: string;
}

export const CODE_PURPOSES = ["access_code", "access_codes"] as const;
export const REMOVED = "[removed]";

const KEY = /^player-code:([^:]+):([^:]+):([^:]+):(.+)$/;

/** Every spelling of a code a message could carry: ABCD-2345, ABCD2345, abcd-2345, abcd2345. */
function spellings(code: string): string[] {
  const bare = normalizeAccessCode(code);
  const out = new Set<string>([code]);
  if (isValidAccessCode(bare)) for (const c of [bare, formatAccessCode(bare)]) for (const v of [c, c.toLowerCase()]) out.add(v);
  return [...out].filter((s) => s.length >= 8).sort((a, b) => b.length - a.length);
}

function scrubText<T>(value: T, secrets: string[]): T {
  if (value === null || value === undefined || !secrets.length) return value;
  let text = JSON.stringify(value);
  for (const s of secrets) text = text.split(s).join(REMOVED);
  return JSON.parse(text) as T;
}

/** What to write back to one row, or null when it holds no code. */
export function scrubDeliveryRow(row: StoredDelivery): DeliveryScrub | null {
  const secrets: string[] = [];
  const vars = row.vars && typeof row.vars === "object" ? { ...row.vars } : null;
  const varCode = vars && typeof vars.code === "string" && vars.code.trim() ? vars.code.trim() : null;
  if (varCode) secrets.push(...spellings(varCode));

  // "Send code"'s idempotency key carried the plain code; the fingerprint that replaced it is 16 hex characters.
  let key: string | undefined;
  const m = row.idempotency_key ? KEY.exec(row.idempotency_key) : null;
  if (m && isValidAccessCode(m[3]!)) {
    secrets.push(...spellings(m[3]!));
    key = `player-code:${m[1]}:${m[2]}:scrubbed-${row.id.replace(/-/g, "").slice(0, 16)}:${m[4]}`;
  }
  const hasVarCode = Boolean(vars && vars.code !== undefined && vars.code !== null);
  if (!secrets.length && !hasVarCode) return null;
  const unique = [...new Set(secrets)].sort((a, b) => b.length - a.length);

  const out: DeliveryScrub = {};
  if (vars && hasVarCode) {
    delete vars.code;
    // A queued announcement row to a player row reads that player's code at send time instead.
    if (row.announcement_id && row.recipient_kind === "player" && row.recipient_id && !vars.code_ref && ["queued", "sending"].includes(row.status)) vars.code_ref = row.recipient_id;
    out.vars = scrubText(vars, unique);
  }
  const payload = scrubText(row.payload, unique);
  if (JSON.stringify(payload) !== JSON.stringify(row.payload)) out.payload = payload;
  if (key) out.idempotency_key = key;
  if (!row.announcement_id && out.payload !== undefined && ["queued", "sending"].includes(row.status)) {
    out.status = "failed";
    out.error_code = "scrubbed";
    out.error_reason = "The code was removed from the message log; send it again from Player codes";
  }
  return Object.keys(out).length ? out : null;
}
