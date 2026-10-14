"use client";

import { useState } from "react";
import { moneyLabel } from "@/lib/registration/rules";

type Choice = "free" | "online" | "venue";
type Kind = "individual" | "team";

export default function RegisterForm({
  slug,
  teamSize,
  kinds,
  options,
  partnerPhoneRequired,
  feePerPlayer,
  approval = "on_payment",
}: {
  slug: string;
  /** Players in a team entry. */
  teamSize: number;
  /** The entry kinds a player may pick (both for an event that takes both). */
  kinds: Kind[];
  options: Choice[];
  partnerPhoneRequired: boolean;
  feePerPlayer: number;
  /** "organiser": the organiser approves first, and an approved entry keeps its place for 24 hours while it is paid. */
  approval?: "on_payment" | "organiser";
}) {
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");
  const [choice, setChoice] = useState<Choice>(options[0] ?? "free");
  const [kind, setKind] = useState<Kind>(kinds[0] ?? "individual");
  const [statusUrl, setStatusUrl] = useState<string | null>(null);
  const people = kind === "team" ? teamSize : 1;
  const totalLabel = feePerPlayer > 0 ? moneyLabel(feePerPlayer * people) : null;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "sending") return;
    setStatus("sending");
    setMessage("");
    const form = new FormData(e.currentTarget);
    const list = Array.from({ length: people }, (_, i) => ({
      name: String(form.get(`p${i}_name`) ?? ""),
      phone: String(form.get(`p${i}_phone`) ?? ""),
      email: String(form.get(`p${i}_email`) ?? ""),
    }));
    try {
      const res = await fetch(`/api/register/${slug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          people: list,
          entryType: kind,
          ...(kind === "team" ? { teamName: String(form.get("team_name") ?? "") } : {}),
          payment: choice,
          website: String(form.get("website") ?? ""),
        }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string; checkoutUrl?: string | null; statusUrl?: string | null };
      if (data.ok && data.checkoutUrl) {
        // The payment provider's hosted checkout; it sends the payer back to the status page.
        window.location.assign(data.checkoutUrl);
        return;
      }
      setMessage(data.message ?? (data.ok ? "Registration received." : "Something went wrong."));
      setStatusUrl(data.statusUrl ?? null);
      setStatus(data.ok ? "done" : "error");
    } catch {
      setMessage("Could not reach the server. Please check your connection and try again.");
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <div className="card space-y-2 text-center">
        <p className="font-bold">Thank you</p>
        <p className="text-sm text-muted">{message}</p>
        {statusUrl && (
          <a className="btn-secondary inline-block text-sm" href={statusUrl}>
            Check the status later
          </a>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-3">
      {kinds.length > 1 && (
        <div className="flex gap-1 rounded-xl border border-border p-1" role="radiogroup" aria-label="How you enter">
          {kinds.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={`flex-1 rounded-lg px-2 py-1.5 text-sm font-semibold ${kind === k ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
            >
              {k === "team" ? `As a team of ${teamSize}` : "On my own"}
            </button>
          ))}
        </div>
      )}
      {kind === "individual" && kinds.includes("team") && <p className="text-xs text-muted">The organiser pairs players who enter on their own.</p>}
      {kind === "team" && (
        <div>
          <label className="label" htmlFor="reg-team">Team name</label>
          <input id="reg-team" name="team_name" className="input" maxLength={60} placeholder="optional" />
        </div>
      )}
      {Array.from({ length: people }, (_, i) => (
        <fieldset key={i} className="space-y-2 rounded-xl border border-border p-3">
          <legend className="px-1 text-xs font-bold uppercase tracking-wide text-muted">{i === 0 ? "You" : `Player ${i + 1}`}</legend>
          <div>
            <label className="label" htmlFor={`p${i}-name`}>Full name</label>
            <input id={`p${i}-name`} name={`p${i}_name`} className="input" autoComplete={i === 0 ? "name" : "off"} required minLength={2} maxLength={80} />
          </div>
          <div>
            <label className="label" htmlFor={`p${i}-phone`}>Mobile{i > 0 && !partnerPhoneRequired ? " (optional)" : ""}</label>
            <input id={`p${i}-phone`} name={`p${i}_phone`} className="input" inputMode="tel" autoComplete={i === 0 ? "tel" : "off"} placeholder="01001234567" required={i === 0 || partnerPhoneRequired} />
          </div>
          {i === 0 && (
            <div>
              <label className="label" htmlFor="p0-email">Email</label>
              <input id="p0-email" name="p0_email" type="email" className="input" autoComplete="email" required />
              <p className="mt-1 text-xs text-muted">We email you a link to confirm your registration. Never shown publicly.</p>
            </div>
          )}
        </fieldset>
      ))}

      {options.length > 1 && (
        <div className="flex gap-1 rounded-xl border border-border p-1" role="radiogroup" aria-label="How to pay">
          {options.map((o) => (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={choice === o}
              onClick={() => setChoice(o)}
              className={`flex-1 rounded-lg px-2 py-1.5 text-sm font-semibold ${choice === o ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
            >
              {o === "online" ? "Pay online" : o === "venue" ? "Pay at the venue" : "Free"}
            </button>
          ))}
        </div>
      )}

      <div aria-hidden className="hidden">
        <label htmlFor="reg-website">Leave this empty</label>
        <input id="reg-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      {choice === "online" && (
        <p className="text-xs text-muted">
          {approval === "organiser"
            ? "After confirming your email, the organiser reviews your entry. Once approved, your place is kept for 24 hours: pay online before then to confirm it."
            : "Only paid entries hold a place: after confirming your email you pay online, and your place is confirmed when your payment goes through."}
        </p>
      )}

      {status === "error" && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-semibold text-danger">{message}</p>}

      <button className="btn-primary w-full" disabled={status === "sending"}>
        {status === "sending" ? "Sending…" : totalLabel ? `Register · ${totalLabel}` : "Register"}
      </button>
    </form>
  );
}
