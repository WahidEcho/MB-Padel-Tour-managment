/**
 * The composer's input, its checks, and the two presets. Pure module, shared by
 * the client form and the server actions so both say the same thing.
 */
import { channelsFor, type Audience } from "./audienceSpec";
import type { WaTemplateChoice } from "./templates";
import type { TemplateSpec } from "./whatsapp";

export type ComposeChannel = "email" | "whatsapp" | "push";
export type AnnouncementKindInput = "announcement" | "access_codes" | "new_tournament";

export interface ComposeInput {
  kind: AnnouncementKindInput;
  title: string;
  body: string;
  channels: ComposeChannel[];
  audience: Audience;
  whatsapp: WaTemplateChoice | null;
  cta: { label: string; url: string } | null;
  tournamentId: string | null;
}

export function validateCompose(input: ComposeInput, spec: TemplateSpec | null): string[] {
  const errors: string[] = [];
  const title = input.title.trim();
  if (!title) errors.push("Add a title (it is the email subject and the push title).");
  if (title.length > 160) errors.push("The title is longer than 160 characters.");
  if (input.body.length > 5000) errors.push("The message is longer than 5,000 characters.");
  if (!input.body.trim() && input.kind !== "access_codes") errors.push("Write the message.");
  if (!input.channels.length) errors.push("Choose at least one channel.");
  const allowed = channelsFor(input.audience.type);
  for (const c of input.channels) if (!allowed[c]) errors.push(`${c === "push" ? "App push" : c === "email" ? "Email" : "WhatsApp"} cannot reach this audience.`);
  if (input.audience.type === "list" && !input.audience.list.trim()) errors.push("Paste at least one email or phone number.");
  if (input.cta && (input.cta.url || input.cta.label) && !/^https:\/\//.test(input.cta.url.replace(/\{[a-z_]+\}/g, "https://x"))) errors.push("The button link must start with https://");
  if (input.channels.includes("whatsapp")) {
    const w = input.whatsapp;
    if (!w?.name) errors.push("Choose an approved WhatsApp template.");
    else if (spec) {
      if (spec.status !== "APPROVED") errors.push(`WhatsApp template "${spec.name}" is ${spec.status}, not approved.`);
      if (w.params.length !== spec.bodyParams) errors.push(`Template "${spec.name}" needs ${spec.bodyParams} variable(s); ${w.params.length} set.`);
      if (w.params.some((p) => p.field === "custom" && !(p.text ?? "").trim())) errors.push("Fill in every custom template variable.");
      if (spec.headerFormat === "IMAGE" && !w.headerImageUrl) errors.push(`Template "${spec.name}" has an image header: add a public https image link.`);
      if (spec.headerFormat && !["IMAGE", "TEXT"].includes(spec.headerFormat)) errors.push(`Template "${spec.name}" has a ${spec.headerFormat} header, which the console cannot fill.`);
      if (spec.headerFormat === "TEXT" && /\{\{\d+\}\}/.test(spec.headerText ?? "")) errors.push(`Template "${spec.name}" has a variable in its header, which the console cannot fill.`);
      if ((w.buttons ?? []).length !== spec.urlButtons.length) errors.push(`Template "${spec.name}" has ${spec.urlButtons.length} link button(s) to fill.`);
      if (input.kind === "access_codes" && !w.params.some((p) => p.field === "code" || (p.field === "custom" && (p.text ?? "").includes("{code}"))))
        errors.push("The WhatsApp template does not include the access code.");
    }
  }
  return errors;
}

export const PRESETS: Record<"access_codes" | "new_tournament", { title: (t: string) => string; body: (t: string) => string; cta: { label: string; url: string } | null }> = {
  access_codes: {
    title: () => "Your Move Score player code",
    body: () =>
      "Hi {first_name},\n\nHere is your personal player code for {tournament}. Open the Move Score app, choose \"I'm a player\" and enter the code to link your matches and profile.\n\nKeep it to yourself.\n\nGet the app: {app_link}",
    cta: { label: "Open Move Score", url: "{app_link}" },
  },
  new_tournament: {
    title: (t) => `${t}: registration is open`,
    body: (t) => `Hi {first_name},\n\n${t} is open for registration. See the dates, venue and categories, and sign up from the tournament page.\n\nSee you on court!`,
    cta: { label: "See the tournament", url: "{link}" },
  },
};
