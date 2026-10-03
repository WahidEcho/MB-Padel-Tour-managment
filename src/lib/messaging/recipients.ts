/**
 * From people to delivery rows. Pure module: the server resolves an audience to
 * `Recipient`s (audience.ts); this decides, per channel, who gets a message and
 * why the others do not, so the preview and the send can never disagree.
 */
import { normalizeEmail } from "./email";
import { toE164 } from "./phone";
import type { Vars } from "./render";
import type { Channel, DeliveryStatus } from "./status";

export interface Recipient {
  kind: "player_profile" | "player" | "list" | "adhoc";
  id: string | null;
  name: string;
  email: string | null;
  /** Raw phone as stored; normalised here. */
  phone: string | null;
  vars: Vars;
  /** Where the email and phone came from (tournament players): player row, profile or team contact. */
  sources?: { email: "player" | "profile" | null; phone: "player" | "profile" | "team" | null };
  /** Channels this person said no to (player_consents granted = false). */
  optedOut?: Channel[];
}

export interface PlannedDelivery {
  channel: Channel;
  recipient_kind: Recipient["kind"];
  recipient_id: string | null;
  recipient_name: string;
  address: string | null;
  vars: Vars;
  status: Extract<DeliveryStatus, "queued" | "skipped">;
  error_code: string | null;
  error_reason: string | null;
}

export interface ChannelPreview {
  reachable: number;
  missing: number;
  invalid: number;
  optedOut: number;
  duplicates: number;
  missingCode: number;
}

export interface PlanOptions {
  /** Every recipient must have an access code (the "send codes" preset). */
  requireCode?: boolean;
  /** Numbers that asked us to stop on WhatsApp (whatsapp_contacts.opted_out_at). */
  waOptedOut?: Set<string>;
}

const SKIP_REASON = {
  no_email: "No email address on file",
  bad_email: "Email address is not valid",
  no_phone: "No phone number on file",
  bad_phone: "Phone number is not a valid mobile number",
  opted_out: "The player has not agreed to this channel",
  wa_stop: "Asked us to stop WhatsApp messages",
  no_code: "No access code yet",
} as const;

export function planDeliveries(recipients: Recipient[], channels: Channel[], opts: PlanOptions = {}): { rows: PlannedDelivery[]; preview: Record<Channel, ChannelPreview> } {
  const rows: PlannedDelivery[] = [];
  const preview = {} as Record<Channel, ChannelPreview>;
  for (const channel of channels) {
    const p: ChannelPreview = { reachable: 0, missing: 0, invalid: 0, optedOut: 0, duplicates: 0, missingCode: 0 };
    preview[channel] = p;
    const seen = new Set<string>();
    for (const r of recipients) {
      const raw = channel === "email" ? r.email : r.phone;
      const address = channel === "email" ? normalizeEmail(raw) : toE164(raw);
      const skip = (code: keyof typeof SKIP_REASON, addr: string | null = address) =>
        rows.push({
          channel,
          recipient_kind: r.kind,
          recipient_id: r.id,
          recipient_name: r.name,
          address: addr,
          vars: r.vars,
          status: "skipped",
          error_code: code,
          error_reason: SKIP_REASON[code],
        });
      if (!raw || !raw.trim()) {
        p.missing++;
        skip(channel === "email" ? "no_email" : "no_phone", null);
        continue;
      }
      if (!address) {
        const typed = raw.trim().slice(0, 120);
        if (seen.has(`invalid:${typed}`)) {
          p.duplicates++;
          continue;
        }
        seen.add(`invalid:${typed}`);
        p.invalid++;
        // Keep what was typed so the organiser can see what to fix.
        skip(channel === "email" ? "bad_email" : "bad_phone", typed);
        continue;
      }
      if (seen.has(address)) {
        // Same person through two routes (or two players sharing a number): one message.
        p.duplicates++;
        continue;
      }
      seen.add(address);
      if (r.optedOut?.includes(channel)) {
        p.optedOut++;
        skip("opted_out");
        continue;
      }
      if (channel === "whatsapp" && opts.waOptedOut?.has(address)) {
        p.optedOut++;
        skip("wa_stop");
        continue;
      }
      if (opts.requireCode && !r.vars.code) {
        p.missingCode++;
        skip("no_code");
        continue;
      }
      p.reachable++;
      rows.push({
        channel,
        recipient_kind: r.kind,
        recipient_id: r.id,
        recipient_name: r.name,
        address,
        vars: r.vars,
        status: "queued",
        error_code: null,
        error_reason: null,
      });
    }
  }
  return { rows, preview };
}

/**
 * A pasted list: one person per line, "Name, email, phone" in any order and any
 * separator (comma, semicolon, tab). Lines with neither an email nor a phone are
 * returned as `rejected` so the composer can show them.
 */
export function parsePastedList(text: string): { recipients: Recipient[]; rejected: string[] } {
  const recipients: Recipient[] = [];
  const rejected: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/[,;\t|]+/).map((p) => p.trim()).filter(Boolean);
    let email: string | null = null;
    let phone: string | null = null;
    const nameParts: string[] = [];
    for (const part of parts) {
      if (!email && part.includes("@")) email = part;
      else if (!phone && /^[+0-9٠-٩][0-9٠-٩\s().-]{6,}$/.test(part)) phone = part;
      else nameParts.push(part);
    }
    if (!email && !phone) {
      rejected.push(trimmed);
      continue;
    }
    const name = nameParts.join(" ").slice(0, 120);
    recipients.push({ kind: "list", id: null, name, email, phone, vars: { name } });
  }
  return { recipients, rejected };
}
