import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { AUTH_TEMPLATES, authSubjects, authTemplateHtml } from "./authTemplates";
import { EMAIL_BRAND, brandedEmail } from "./layout";

const TEMPLATE_DIR = join(__dirname, "../../../supabase/email-templates");

describe("branded email layout", () => {
  const e = brandedEmail({
    title: "Hello <b>Sara</b>",
    body: 'Line "one" & <script>alert(1)</script>\n\nSee https://tour.mbeg.org/t/x.',
    code: { label: "Your code", value: "<AB12>" },
    button: { label: "Open <app>", url: 'https://x.test/a?b=1&c="2"' },
    linkFallback: true,
    note: "Ignore <this>",
    reason: "Because <you> signed up",
  });

  it("escapes everything the sender typed", () => {
    expect(e.html).not.toContain("<script>");
    expect(e.html).not.toContain("<b>Sara</b>");
    expect(e.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(e.html).toContain("<title>Hello &lt;b&gt;Sara&lt;/b&gt;</title>");
    expect(e.html).toContain("&lt;AB12&gt;");
    expect(e.html).toContain('href="https://x.test/a?b=1&amp;c=&quot;2&quot;"');
    expect(e.html).toContain("Open &lt;app&gt;");
    expect(e.html).toContain("Because &lt;you&gt; signed up");
    expect(e.html).toContain('<a href="https://tour.mbeg.org/t/x"');
  });

  it("has the Move Score header, preheader and Move Beyond signature", () => {
    expect(e.html).toContain(`${EMAIL_BRAND.assetBase}/move-score-lockup@2x.png`);
    expect(e.html).toContain('alt="Move Score"');
    expect(e.html).toMatch(/<div style="display:none;[^"]*">Line &quot;one&quot;/);
    expect(e.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(e.html).toContain("@media (prefers-color-scheme:dark)");
    expect(e.html).toContain("is made by <a href=\"https://mbeg.org\"");
    expect(e.html).toContain("mailto:info@mbeg.org");
    expect(e.html).toContain(EMAIL_BRAND.privacyUrl);
    expect(e.html).toContain(EMAIL_BRAND.legal);
    expect(e.html).toContain("max-width:600px");
  });

  it("has a plain-text part with the code, link and signature", () => {
    expect(e.text.split("\n")[0]).toBe("Hello <b>Sara</b>");
    expect(e.text).toContain("Your code: <AB12>");
    expect(e.text).toContain('Open <app>: https://x.test/a?b=1&c="2"');
    expect(e.text).toContain("Move Score is made by Move Beyond · https://mbeg.org");
    expect(e.text).toContain("Questions? Write to info@mbeg.org");
    expect(e.text).toContain(`Privacy: ${EMAIL_BRAND.privacyUrl}`);
    expect(e.text).not.toContain("\n\n\n");
  });
});

describe("Supabase auth templates", () => {
  it("link to the redirect URL with the token hash and the right type", () => {
    const want: Record<string, string | null> = {
      "confirm-signup": "email",
      "magic-link": "magiclink",
      "reset-password": "recovery",
      "change-email": "email_change",
      invite: "invite",
      reauthentication: null,
    };
    for (const t of AUTH_TEMPLATES) {
      const html = authTemplateHtml(t);
      const type = want[t.id];
      if (type) expect(html, t.id).toContain(`href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&amp;type=${type}"`);
      else expect(html, t.id).not.toContain("{{ .TokenHash }}");
      // Only Supabase variables, written the Go-template way.
      for (const m of html.matchAll(/\{\{(.*?)\}\}/g)) expect(m[1], t.id).toMatch(/^ \.(ConfirmationURL|Token|TokenHash|Email|NewEmail|SiteURL|RedirectTo) $/);
      expect(html, t.id).toContain("Move Score</strong> is made by");
    }
    const byId = Object.fromEntries(AUTH_TEMPLATES.map((t) => [t.id, authTemplateHtml(t)]));
    expect(byId["reauthentication"]).toContain("{{ .Token }}");
    expect(byId["confirm-signup"]).toContain("{{ .Token }}");
    expect(byId["change-email"]).toContain("{{ .NewEmail }}");
  });

  it("match the files in supabase/email-templates (run scripts/email/build-auth-templates.ts)", () => {
    for (const t of AUTH_TEMPLATES) expect(readFileSync(join(TEMPLATE_DIR, `${t.id}.html`), "utf8"), t.id).toBe(authTemplateHtml(t));
    expect(JSON.parse(readFileSync(join(TEMPLATE_DIR, "subjects.json"), "utf8"))).toEqual(authSubjects());
  });
});
