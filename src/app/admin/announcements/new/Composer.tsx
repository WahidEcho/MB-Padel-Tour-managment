"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { channelsFor, type Audience } from "@/lib/messaging/audienceSpec";
import type { AnnouncementKindInput, ComposeChannel, ComposeInput } from "@/lib/messaging/compose";
import { MERGE_FIELDS, renderEmail } from "@/lib/messaging/render";
import { PARAM_FIELDS, defaultParams, type ParamField, type ParamSource, type WaTemplateChoice } from "@/lib/messaging/templates";
import type { TemplateSpec } from "@/lib/messaging/whatsapp";
import { createAndSendAction, previewAction, refreshTemplatesAction, sendTestAction, type PreviewResult } from "../actions";

type Initial = {
  kind: AnnouncementKindInput;
  title: string;
  body: string;
  cta: { label: string; url: string } | null;
  tournamentId: string | null;
  audience: Audience;
};

const CHANNEL_LABEL: Record<ComposeChannel, string> = { email: "Email", whatsapp: "WhatsApp", push: "App push (Move Score)" };

export default function Composer({
  initial,
  tournaments,
  nations,
  templates,
  templatesError,
}: {
  initial: Initial;
  tournaments: { id: string; name: string; status: string }[];
  nations: { code: string; teams: number }[];
  templates: TemplateSpec[];
  templatesError: string | null;
}) {
  const router = useRouter();
  const [kind] = useState(initial.kind);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [tournamentId, setTournamentId] = useState(initial.tournamentId ?? "");
  const [audType, setAudType] = useState<Audience["type"]>(initial.audience.type);
  const [audTournament, setAudTournament] = useState(initial.audience.type === "tournament" ? initial.audience.tournamentId : initial.tournamentId ?? "");
  const [audNation, setAudNation] = useState(nations[0]?.code ?? "");
  const [audList, setAudList] = useState("");
  const [channels, setChannels] = useState<ComposeChannel[]>(["email"]);
  const [ctaLabel, setCtaLabel] = useState(initial.cta?.label ?? "");
  const [ctaUrl, setCtaUrl] = useState(initial.cta?.url ?? "");
  const [tplKey, setTplKey] = useState("");
  const [params, setParams] = useState<ParamSource[]>([]);
  const [headerImage, setHeaderImage] = useState("");
  const [buttons, setButtons] = useState<{ index: number; source: ParamSource }[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [testEmail, setTestEmail] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [pending, start] = useTransition();

  const spec = templates.find((t) => `${t.name}|${t.language}` === tplKey) ?? null;
  const allowed = channelsFor(audType);
  const activeChannels = channels.filter((c) => allowed[c]);

  const audience: Audience =
    audType === "tournament"
      ? { type: "tournament", tournamentId: audTournament }
      : audType === "nation"
        ? { type: "nation", nationCode: audNation }
        : audType === "list"
          ? { type: "list", list: audList }
          : { type: audType };

  const whatsapp: WaTemplateChoice | null = spec ? { name: spec.name, language: spec.language, params, headerImageUrl: headerImage || null, buttons } : null;

  const input = (): ComposeInput => ({
    kind,
    title,
    body,
    channels: activeChannels,
    audience,
    whatsapp: activeChannels.includes("whatsapp") ? whatsapp : null,
    cta: ctaUrl ? { label: ctaLabel || "Open", url: ctaUrl } : null,
    tournamentId: tournamentId || (audType === "tournament" ? audTournament : null) || null,
  });

  function pickTemplate(key: string) {
    setTplKey(key);
    const s = templates.find((t) => `${t.name}|${t.language}` === key);
    setParams(s ? defaultParams(s.bodyParams, kind) : []);
    setButtons(s ? s.urlButtons.map((b) => ({ index: b.index, source: { field: "custom" as ParamField, text: "" } })) : []);
    setHeaderImage("");
  }

  function toggle(c: ComposeChannel) {
    setChannels((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
    setPreview(null);
  }

  const tName = tournaments.find((t) => t.id === (tournamentId || audTournament))?.name ?? "Spring Open";
  const emailPreview = useMemo(
    () =>
      renderEmail(
        { title: title || "(title)", body, cta: ctaUrl ? { label: ctaLabel || "Open", url: ctaUrl } : null, code: kind === "access_codes" ? "{code}" : null },
        { name: "Omar Khaled", code: "MB7Q2K", tournament: tName, link: "https://mb-tournament.vercel.app/t/…", app_link: "https://mb-tournament.vercel.app/movescore" },
      ),
    [title, body, ctaUrl, ctaLabel, kind, tName],
  );

  const waPreview = spec
    ? spec.bodyText.replace(/\{\{(\d+)\}\}/g, (_, n: string) => {
        const p = params[Number(n) - 1];
        if (!p) return `{{${n}}}`;
        if (p.field === "custom") return p.text || `{{${n}}}`;
        if (p.field === "message") return body.replace(/\s*\n+\s*/g, " · ");
        if (p.field === "title") return title;
        return `{${p.field}}`;
      })
    : "";

  const doPreview = () =>
    start(async () => {
      setErrors([]);
      setPreview(await previewAction(input()));
    });

  const doTest = () =>
    start(async () => {
      setTestResult(null);
      const r = await sendTestAction(input(), { email: testEmail, phone: testPhone });
      const parts: string[] = [];
      if (r.email) parts.push(`Email: ${r.email.ok ? "sent ✓" : `not sent — ${r.email.error}`}`);
      if (r.whatsapp) parts.push(`WhatsApp: ${r.whatsapp.ok ? "sent ✓ (watch for delivery on the phone)" : `not sent — ${r.whatsapp.error}`}`);
      setTestResult(parts.length ? `${parts.join(" · ")} (filled in as ${r.usedName})` : "Type an email or phone number first.");
    });

  const doSend = () =>
    start(async () => {
      const p = await previewAction(input());
      setPreview(p);
      if (!p.ok) {
        setErrors(p.errors);
        return;
      }
      const reach = Object.entries(p.channels).map(([c, v]) => `${v!.reachable} by ${c}`);
      if (p.pushDevices != null) reach.push(`${p.pushDevices} app phones`);
      if (!window.confirm(`Send "${title}" now?\n\n${p.people} people · ${reach.join(" · ")}\n\nThis cannot be undone.`)) return;
      const r = await createAndSendAction(input());
      if (r.errors?.length) {
        setErrors(r.errors);
        if (r.id) router.push(`/admin/announcements/${r.id}`);
        return;
      }
      router.push(`/admin/announcements/${r.id}`);
    });

  const insertField = (key: string) => setBody((b) => `${b}${b && !b.endsWith(" ") && !b.endsWith("\n") ? " " : ""}{${key}}`);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-4">
        {/* Audience */}
        <section className="card space-y-3">
          <h2 className="label">Who</h2>
          <div className="flex flex-wrap gap-2" role="radiogroup">
            {(["all_players", "tournament", "nation", "app_users", "list"] as const).map((t) => (
              <label key={t} className={`cursor-pointer rounded-xl border px-3 py-1.5 text-sm ${audType === t ? "border-accent bg-accent/10 font-semibold text-accent" : "border-border"}`}>
                <input type="radio" name="aud" className="sr-only" checked={audType === t} onChange={() => { setAudType(t); setPreview(null); }} />
                {{ all_players: "All players", tournament: "A tournament's players", nation: "A nation's players", app_users: "App users", list: "Paste a list" }[t]}
              </label>
            ))}
          </div>
          {audType === "tournament" && (
            <select className="input" value={audTournament} onChange={(e) => { setAudTournament(e.target.value); setPreview(null); }} data-testid="aud-tournament">
              <option value="">Choose a tournament…</option>
              {tournaments.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.status})</option>)}
            </select>
          )}
          {audType === "nation" && (
            <select className="input" value={audNation} onChange={(e) => { setAudNation(e.target.value); setPreview(null); }}>
              {nations.length === 0 && <option value="">No nations yet</option>}
              {nations.map((n) => <option key={n.code} value={n.code}>{n.code} ({n.teams} team{n.teams === 1 ? "" : "s"})</option>)}
            </select>
          )}
          {audType === "list" && (
            <textarea className="input min-h-28 font-mono text-xs" value={audList} onChange={(e) => { setAudList(e.target.value); setPreview(null); }} placeholder={"One person per line: name, email, phone\nOmar Khaled, omar@example.com, 0100 123 4567\n+201112223334"} data-testid="aud-list" />
          )}
          {audType === "app_users" && <p className="text-xs text-muted">App users have no email or phone on file: they are reached by push only.</p>}
          {kind !== "announcement" && audType !== "tournament" && (
            <div>
              <label className="label" htmlFor="ctx-t">Tournament (fills {"{tournament}"} and {"{link}"})</label>
              <select id="ctx-t" className="input" value={tournamentId} onChange={(e) => setTournamentId(e.target.value)}>
                <option value="">None</option>
                {tournaments.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          )}
        </section>

        {/* Channels */}
        <section className="card space-y-2">
          <h2 className="label">How</h2>
          <div className="flex flex-wrap gap-3">
            {(["email", "whatsapp", "push"] as const).map((c) => (
              <label key={c} className={`flex items-center gap-2 text-sm ${allowed[c] ? "" : "opacity-40"}`}>
                <input type="checkbox" checked={channels.includes(c) && allowed[c]} disabled={!allowed[c]} onChange={() => toggle(c)} data-testid={`ch-${c}`} />
                {CHANNEL_LABEL[c]}
              </label>
            ))}
          </div>
          {channels.includes("push") && !allowed.push && <p className="text-xs text-muted">App push reaches a tournament&apos;s or nation&apos;s followers, or all app users.</p>}
        </section>

        {/* Message */}
        <section className="card space-y-3">
          <h2 className="label">What</h2>
          <div>
            <label className="label" htmlFor="title">Title (email subject, push title)</label>
            <input id="title" className="input" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} data-testid="title" />
          </div>
          <div>
            <label className="label" htmlFor="body">Message</label>
            <textarea id="body" className="input min-h-40" value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} data-testid="body" />
            <div className="mt-1 flex flex-wrap gap-1">
              {MERGE_FIELDS.map((f) => (
                <button key={f.key} type="button" className="badge cursor-pointer bg-border text-muted hover:text-foreground" onClick={() => insertField(f.key)} title={f.label}>
                  {`{${f.key}}`}
                </button>
              ))}
            </div>
          </div>
          {activeChannels.includes("email") && (
            <div className="grid gap-2 sm:grid-cols-[160px_1fr]">
              <div>
                <label className="label" htmlFor="cta-l">Email button</label>
                <input id="cta-l" className="input" value={ctaLabel} onChange={(e) => setCtaLabel(e.target.value)} placeholder="Label" />
              </div>
              <div>
                <label className="label" htmlFor="cta-u">Button link (optional)</label>
                <input id="cta-u" className="input" value={ctaUrl} onChange={(e) => setCtaUrl(e.target.value)} placeholder="https://… or {link}" />
              </div>
            </div>
          )}
        </section>

        {/* WhatsApp template */}
        {activeChannels.includes("whatsapp") && (
          <section className="card space-y-3" data-testid="wa-section">
            <div className="flex items-center justify-between gap-2">
              <h2 className="label">WhatsApp template</h2>
              <button type="button" className="text-xs text-muted hover:text-foreground" onClick={() => start(async () => { await refreshTemplatesAction(); router.refresh(); })}>Refresh list</button>
            </div>
            <p className="text-xs text-muted">
              WhatsApp only delivers approved templates to people who have not written to us in the last 24 hours. Pick one and say what fills each variable.
            </p>
            {templatesError && <p className="text-xs text-danger">Could not load templates: {templatesError}</p>}
            <select className="input" value={tplKey} onChange={(e) => pickTemplate(e.target.value)} data-testid="wa-template">
              <option value="">Choose a template…</option>
              {templates.map((t) => (
                <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`} disabled={t.status !== "APPROVED"}>
                  {t.name} · {t.language} · {t.category?.toLowerCase()} {t.status !== "APPROVED" ? `(${t.status.toLowerCase()})` : ""}
                </option>
              ))}
            </select>
            {spec && (
              <>
                <pre className="whitespace-pre-wrap rounded-xl border border-border bg-background p-3 text-xs">{spec.headerText ? `*${spec.headerText}*\n\n` : ""}{waPreview}{spec.footer ? `\n\n${spec.footer}` : ""}</pre>
                {params.map((p, i) => (
                  <div key={i} className="grid gap-2 sm:grid-cols-[60px_200px_1fr]">
                    <span className="self-center font-mono text-xs text-muted">{`{{${i + 1}}}`}</span>
                    <select className="input" value={p.field} onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, field: e.target.value as ParamField } : x)))} data-testid={`wa-param-${i + 1}`}>
                      {PARAM_FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                    {p.field === "custom" && (
                      <input className="input" value={p.text ?? ""} onChange={(e) => setParams((ps) => ps.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} placeholder="Text (merge fields allowed)" />
                    )}
                  </div>
                ))}
                {spec.headerFormat === "IMAGE" && (
                  <div>
                    <label className="label" htmlFor="wa-img">Header image (public https link)</label>
                    <input id="wa-img" className="input" value={headerImage} onChange={(e) => setHeaderImage(e.target.value)} placeholder="https://…/poster.jpg" />
                  </div>
                )}
                {spec.urlButtons.map((b, i) => (
                  <div key={b.index} className="grid gap-2 sm:grid-cols-[1fr_200px_1fr]">
                    <span className="self-center text-xs text-muted">Button “{b.text}”: {b.url}</span>
                    <select className="input" value={buttons[i]?.source.field ?? "custom"} onChange={(e) => setButtons((bs) => bs.map((x, j) => (j === i ? { ...x, source: { ...x.source, field: e.target.value as ParamField } } : x)))}>
                      {PARAM_FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                    {buttons[i]?.source.field === "custom" && (
                      <input className="input" value={buttons[i]?.source.text ?? ""} onChange={(e) => setButtons((bs) => bs.map((x, j) => (j === i ? { ...x, source: { ...x.source, text: e.target.value } } : x)))} placeholder="URL ending" />
                    )}
                  </div>
                ))}
              </>
            )}
          </section>
        )}

        {errors.length > 0 && (
          <ul className="card space-y-1 border-danger/40 text-sm text-danger" data-testid="errors">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )}

        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-secondary" onClick={doPreview} disabled={pending} data-testid="preview">Preview recipients</button>
          <button type="button" className="btn-primary" onClick={doSend} disabled={pending} data-testid="send">{pending ? "Working…" : "Send…"}</button>
        </div>
      </div>

      <aside className="space-y-4">
        {preview && (
          <section className="card space-y-2 text-sm" data-testid="preview-result">
            <h2 className="label">Recipients</h2>
            <p><b data-testid="people">{preview.people}</b> {preview.people === 1 ? "person" : "people"}</p>
            {Object.entries(preview.channels).map(([c, v]) => (
              <div key={c} className="rounded-xl border border-border p-2" data-testid={`preview-${c}`}>
                <p className="font-semibold">{c === "email" ? "Email" : "WhatsApp"}: <span className="text-success" data-n="reachable">{v!.reachable}</span> will get it</p>
                <ul className="text-xs text-muted">
                  {v!.missing > 0 && <li><span className="text-warning">{v!.missing}</span> have no {c === "email" ? "email address" : "phone number"}</li>}
                  {v!.invalid > 0 && <li><span className="text-warning">{v!.invalid}</span> have an invalid {c === "email" ? "address" : "number"}</li>}
                  {v!.optedOut > 0 && <li><span className="text-warning">{v!.optedOut}</span> opted out</li>}
                  {v!.missingCode > 0 && <li><span className="text-warning">{v!.missingCode}</span> have no access code yet</li>}
                  {v!.duplicates > 0 && <li>{v!.duplicates} duplicates merged</li>}
                </ul>
                {preview.ready[c as "email" | "whatsapp"]?.ok === false && <p className="text-xs text-danger">Not set up: {preview.ready[c as "email" | "whatsapp"]?.why}</p>}
              </div>
            ))}
            {preview.pushDevices != null && <p>App push: <b>{preview.pushDevices}</b> phones</p>}
            {preview.missingMergeFields.length > 0 && (
              <p className="text-xs text-warning">Some people have no value for {preview.missingMergeFields.map((f) => `{${f}}`).join(", ")}: it will be left blank.</p>
            )}
            {preview.rejectedLines.length > 0 && (
              <p className="text-xs text-warning">Lines with no email or phone: {preview.rejectedLines.join(" | ")}</p>
            )}
            {preview.sample.length > 0 && (
              <ul className="text-xs text-muted">
                {preview.sample.map((s, i) => <li key={i}>{s.name || "(no name)"} · {s.email ?? "no email"} · {s.phone ?? "no phone"}{s.code ? ` · code ${s.code}` : ""}</li>)}
              </ul>
            )}
            {preview.errors.length > 0 && <ul className="text-xs text-danger">{preview.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
            {preview.transport === "dry-run" && <p className="text-xs text-warning">Dry run: nothing leaves the server.</p>}
          </section>
        )}

        <section className="card space-y-2">
          <h2 className="label">Send test to me</h2>
          <input className="input" type="email" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="you@example.com" data-testid="test-email" />
          <input className="input" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="WhatsApp number, e.g. 0100 123 4567" data-testid="test-phone" />
          <button type="button" className="btn-secondary w-full" onClick={doTest} disabled={pending || (!testEmail && !testPhone)} data-testid="send-test">Send test</button>
          {testResult && <p className="text-xs" data-testid="test-result">{testResult}</p>}
        </section>

        {activeChannels.includes("email") && (
          <section className="card space-y-2">
            <h2 className="label">Email preview</h2>
            <iframe title="Email preview" srcDoc={emailPreview.html} sandbox="" className="h-[420px] w-full rounded-xl border border-border bg-white" />
          </section>
        )}
      </aside>
    </div>
  );
}
