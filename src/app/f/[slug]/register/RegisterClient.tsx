"use client";

import { useState } from "react";

export default function RegisterClient({ slug }: { slug: string }) {
  const [status, setStatus] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "sending") return;
    setStatus("sending");
    setMessage("");

    const form = new FormData(e.currentTarget);
    try {
      const res = await fetch(`/api/f/${slug}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          public_name: form.get("public_name"),
          mobile: form.get("mobile"),
          consent_whatsapp: form.get("consent_whatsapp") === "on",
          website: form.get("website"), // honeypot
        }),
      });
      const data = (await res.json()) as { ok: boolean; message?: string };
      setMessage(data.message ?? (data.ok ? "Registration received." : "Something went wrong."));
      setStatus(data.ok ? "done" : "error");
    } catch {
      setMessage("Could not reach the server. Please check your connection and try again.");
      setStatus("error");
    }
  }

  if (status === "done") {
    return (
      <div className="card space-y-2 text-center">
        <p className="text-3xl">✅</p>
        <p className="font-bold">You&apos;re on the list</p>
        <p className="text-sm text-muted">{message}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card space-y-3">
      <div>
        <label className="label" htmlFor="reg-name">Your name</label>
        <input
          id="reg-name"
          name="public_name"
          className="input"
          autoComplete="name"
          required
          minLength={2}
          maxLength={80}
        />
        <p className="mt-1 text-xs text-muted">This is the name shown on rankings.</p>
      </div>

      <div>
        <label className="label" htmlFor="reg-mobile">Mobile number</label>
        <input
          id="reg-mobile"
          name="mobile"
          className="input"
          inputMode="tel"
          autoComplete="tel"
          placeholder="01001234567"
          required
        />
        <p className="mt-1 text-xs text-muted">
          Used by the organisers to reach you. Never shown publicly.
        </p>
      </div>

      {/* Honeypot — hidden from people, tempting to bots. */}
      <div aria-hidden className="hidden">
        <label htmlFor="reg-website">Leave this empty</label>
        <input id="reg-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <label className="flex items-start gap-2 text-sm">
        {/* Opt-in, unticked by default. */}
        <input type="checkbox" name="consent_whatsapp" className="mt-1" />
        <span>
          Send me session updates on WhatsApp — court times, team changes and results.
          <span className="block text-xs text-muted">Optional. You can ask us to stop at any time.</span>
        </span>
      </label>

      {status === "error" && (
        <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-semibold text-danger">{message}</p>
      )}

      <button className="btn-primary w-full" disabled={status === "sending"}>
        {status === "sending" ? "Sending…" : "Register"}
      </button>
      <p className="text-center text-xs text-muted">
        An organiser confirms every registration, so your place isn&apos;t final until they do.
      </p>
    </form>
  );
}
