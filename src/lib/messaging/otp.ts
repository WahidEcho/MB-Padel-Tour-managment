/**
 * The WhatsApp authentication template that carries a phone one-time code.
 *
 * Meta only delivers one-time codes through templates of the AUTHENTICATION
 * category: a fixed body ("<code> is your verification code.", with an optional
 * security note and expiry line) and a "Copy code" button. Sending one takes the
 * code twice: as the body's {{1}} and as the button's parameter. The definition to
 * submit is in docs/messaging.md ("Authentication template").
 *
 *   WA_OTP_TEMPLATE       the approved template's name (e.g. mb_login_code)
 *   WA_OTP_TEMPLATE_LANG  its language code (default "en")
 *
 * Until it is set (the template is not approved yet), a live server answers
 * "not configured" and the app offers the email instead; a dry run uses a stand-in
 * name so the flow can be tested end to end.
 */
import type { TemplateSend } from "./whatsapp";
import { transportMode } from "./transport";

export const DRY_RUN_OTP_TEMPLATE = "mb_login_code";

export function otpTemplateName(env: NodeJS.ProcessEnv = process.env): { name: string; language: string } | null {
  const name = env.WA_OTP_TEMPLATE?.trim();
  if (name && /^[a-z0-9_]{1,512}$/.test(name)) return { name, language: env.WA_OTP_TEMPLATE_LANG?.trim() || "en" };
  return transportMode(env) === "dry-run" ? { name: DRY_RUN_OTP_TEMPLATE, language: "en" } : null;
}

/** The send: the code as the body parameter and the copy-code button's parameter. */
export function otpTemplate(code: string, env: NodeJS.ProcessEnv = process.env): TemplateSend | null {
  const t = otpTemplateName(env);
  return t ? { name: t.name, language: t.language, bodyParams: [code], buttonParams: [{ index: 0, value: code }] } : null;
}
