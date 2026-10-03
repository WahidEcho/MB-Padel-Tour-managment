"use client";

import { useState } from "react";

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
