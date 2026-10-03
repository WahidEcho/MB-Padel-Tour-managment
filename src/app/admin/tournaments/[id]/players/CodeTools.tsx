"use client";

import { useActionState, useState } from "react";

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and non-HTTPS origins: a hidden textarea and execCommand.
    const el = document.createElement("textarea");
    el.value = text;
    el.setAttribute("readonly", "");
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    el.remove();
    return ok;
  }
}

/** Copies `text`, and says so for a moment. */
export function CopyButton({ text, label = "Copy", className = "btn-secondary text-xs" }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        setState((await copy(text)) ? "done" : "failed");
        setTimeout(() => setState("idle"), 1600);
      }}
    >
      {state === "done" ? "Copied ✓" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

/** "Copy all codes as CSV", and the same as a file. */
export function CsvTools({ csv, filename }: { csv: string; filename: string }) {
  return (
    <div className="flex flex-wrap gap-2">
      <CopyButton text={csv} label="Copy all codes as CSV" className="btn-primary text-sm" />
      <button
        type="button"
        className="btn-secondary text-sm"
        onClick={() => {
          const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >
        ⬇ Download CSV
      </button>
    </div>
  );
}

/**
 * "Send code" by email or WhatsApp through the messaging service (tracked in
 * Announcements' delivery log), next to the share links that open your own apps.
 */
export function SendCodeButtons({
  tournamentId,
  playerId,
  canEmail,
  canWhatsApp,
  action,
}: {
  tournamentId: string;
  playerId: string;
  canEmail: boolean;
  canWhatsApp: boolean;
  action: (prev: { ok: boolean; message: string } | null, formData: FormData) => Promise<{ ok: boolean; message: string }>;
}) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className="flex flex-wrap items-center gap-2" data-testid="send-code">
      <input type="hidden" name="tournament_id" value={tournamentId} />
      <input type="hidden" name="player_id" value={playerId} />
      <button name="channel" value="email" className="btn-primary text-xs" disabled={pending || !canEmail} title={canEmail ? "Send the code by email now" : "No email address"}>
        Send code by email
      </button>
      <button name="channel" value="whatsapp" className="btn-primary text-xs" disabled={pending || !canWhatsApp} title={canWhatsApp ? "Send the code on WhatsApp now (approved template)" : "No phone number"}>
        Send code on WhatsApp
      </button>
      {pending && <span className="text-xs text-muted">Sending…</span>}
      {state && !pending && <span className={`text-xs ${state.ok ? "text-success" : "text-danger"}`} data-testid="send-code-result">{state.message}</span>}
    </form>
  );
}
