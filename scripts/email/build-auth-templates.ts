/**
 * Writes the Supabase Auth email templates from src/lib/email/authTemplates.ts:
 *
 *   npx tsx scripts/email/build-auth-templates.ts            # supabase/email-templates/*.html + subjects.json
 *   npx tsx scripts/email/build-auth-templates.ts --samples DIR
 *       # also writes every email (auth templates with example values, and our own
 *       # Resend emails) as HTML to DIR, for previews (see docs/email.md)
 *
 * Paste each .html into Supabase → Authentication → Emails (docs/email.md). The
 * test in src/lib/email/email.test.ts fails when the files are out of date.
 */
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { EMAIL_BRAND } from "../../src/lib/email/layout";
import { AUTH_TEMPLATES, authSubjects, authTemplateHtml } from "../../src/lib/email/authTemplates";
import { transactionalEmail } from "../../src/lib/messaging/templates";
import { renderEmail } from "../../src/lib/messaging/render";

const OUT = resolve(__dirname, "../../supabase/email-templates");
mkdirSync(OUT, { recursive: true });
for (const t of AUTH_TEMPLATES) writeFileSync(join(OUT, `${t.id}.html`), authTemplateHtml(t));
writeFileSync(join(OUT, "subjects.json"), `${JSON.stringify(authSubjects(), null, 2)}\n`);
console.log(`Wrote ${AUTH_TEMPLATES.length} templates and subjects.json to ${OUT}`);

const i = process.argv.indexOf("--samples");
if (i > 0) {
  const dir = resolve(process.argv[i + 1] ?? "email-samples");
  mkdirSync(dir, { recursive: true });
  const example: Record<string, string> = {
    "{{ .RedirectTo }}": "https://mb-tournament.vercel.app/movescore/auth/confirm",
    "{{ .TokenHash }}": "pkce_3f1c9a…",
    "{{ .Token }}": "482913",
    "{{ .Email }}": "sara.ali@example.com",
    "{{ .NewEmail }}": "sara@example.org",
    "{{ .SiteURL }}": "https://mb-tournament.vercel.app",
    "{{ .ConfirmationURL }}": "https://mb-tournament.vercel.app/movescore/auth/confirm",
  };
  const fill = (html: string) => Object.entries(example).reduce((h, [k, v]) => h.split(k).join(v), html);
  const samples: { file: string; label: string; subject: string; html: string }[] = AUTH_TEMPLATES.map((t) => ({
    file: `auth-${t.id}.html`,
    label: `Supabase · ${t.dashboardName}`,
    subject: t.subject,
    html: fill(authTemplateHtml(t)),
  }));
  const app = "https://mb-tournament.vercel.app/movescore";
  const own = [
    ["access-code", "Resend · Player code", transactionalEmail("access_code", { name: "Sara Ali", code: "MB7Q-2K4X", tournament: "Junior Team Finals", app_link: app })],
    ["confirmation", "Resend · Confirmation", transactionalEmail("confirmation", { name: "Omar Khaled", title: "Registration received", message: "We have your entry for {tournament}. The draw is published on Thursday; you'll get your first match time the day before.", tournament: "Cairo Spring Open" })],
    ["new-tournament", "Resend · New tournament", transactionalEmail("new_tournament", { name: "Omar Khaled", tournament: "Cairo Spring Open", message: "Men's and women's doubles, 14–16 November at Smash Club. Entries close on 7 November.", link: "https://mb-tournament.vercel.app/t/cairo-spring-open" })],
    ["announcement", "Resend · Announcement", renderEmail({ title: "Order of play is out", body: "Hi {first_name},\n\nTomorrow's order of play is published. Courts open at 9:00 and the first matches start at 9:30.\n\nSee your matches: https://mb-tournament.vercel.app/t/cairo-spring-open", cta: { label: "Open Move Score", url: app } }, { name: "Omar Khaled" })],
  ] as const;
  for (const [id, label, e] of own) samples.push({ file: `resend-${id}.html`, label, subject: e.subject, html: e.html });
  // Previews load the logos from a local copy of public/email/ (the live site may not have them yet).
  const assets = resolve(dir, "../assets");
  mkdirSync(assets, { recursive: true });
  const pub = resolve(__dirname, "../../public/email");
  for (const f of readdirSync(pub)) copyFileSync(join(pub, f), join(assets, f));
  for (const s of samples) writeFileSync(join(dir, s.file), s.html.split(`${EMAIL_BRAND.assetBase}/`).join("../assets/"));
  writeFileSync(join(dir, "samples.json"), JSON.stringify(samples.map(({ file, label, subject }) => ({ file, label, subject })), null, 2));
  console.log(`Wrote ${samples.length} sample emails to ${dir}`);
}
