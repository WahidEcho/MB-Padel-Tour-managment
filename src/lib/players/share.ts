/**
 * Sharing a player's code: the message, the WhatsApp and email links, and the
 * CSV of every code in a tournament. Pure module, used by the admin page.
 */
import { formatAccessCode } from "./accessCode";
import { whatsAppDigits } from "./phone";

/** Where the message sends people to get the app. */
export const APP_PAGE_URL = "https://mb-tournament.vercel.app/movescore";

export interface CodeMessageInput {
  playerName: string;
  tournamentName: string;
  code: string;
  appUrl?: string;
}

export function codeMessage({ playerName, tournamentName, code, appUrl = APP_PAGE_URL }: CodeMessageInput): string {
  const first = playerName.trim().split(/\s+/)[0] || playerName.trim();
  return [
    `Hi ${first}, this is your Move Score player code for ${tournamentName}:`,
    "",
    formatAccessCode(code),
    "",
    `Get the app: ${appUrl}`,
    "Sign in, open Account, tap Player code and enter it. You'll see your matches, and you can add your photo and phone number.",
    "",
    "Keep this code to yourself: it links your player profile to your account.",
  ].join("\n");
}

export const codeEmailSubject = (tournamentName: string) => `Your Move Score player code · ${tournamentName}`;

/** https://wa.me/201001234567?text=… — a chat with that number, the message typed in. Without a number, WhatsApp asks who to send it to. */
export function whatsAppLink(e164: string | null | undefined, text: string): string {
  const to = e164 ? whatsAppDigits(e164) : "";
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}

export function mailtoLink(email: string | null | undefined, subject: string, body: string): string {
  // mailto wants %20 for spaces, not "+", so encodeURIComponent rather than URLSearchParams.
  return `mailto:${email ? encodeURIComponent(email.trim()).replace(/%40/g, "@") : ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * One CSV cell. Quoted when it holds a comma, quote or line break; a leading
 * = + - @ is defused with an apostrophe so a spreadsheet does not run it as a
 * formula (CSV injection), except for a phone number's leading plus.
 */
export function csvCell(value: string | null | undefined, opts: { phone?: boolean } = {}): string {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(s) && !(opts.phone && /^\+\d+$/.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CodeCsvRow {
  name: string;
  team: string;
  code: string | null;
  phone: string | null;
  email: string | null;
  linked: boolean;
}

export function codesCsv(rows: CodeCsvRow[]): string {
  const head = "player,team,code,phone,email,linked";
  const body = rows.map((r) =>
    [csvCell(r.name), csvCell(r.team), csvCell(r.code ? formatAccessCode(r.code) : ""), csvCell(r.phone, { phone: true }), csvCell(r.email), r.linked ? "yes" : "no"].join(","),
  );
  return [head, ...body].join("\n") + "\n";
}
