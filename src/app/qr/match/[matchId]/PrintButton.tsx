"use client";

export default function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="rounded-xl border border-neutral-300 px-4 py-2 text-sm font-semibold print:hidden">
      Print
    </button>
  );
}
