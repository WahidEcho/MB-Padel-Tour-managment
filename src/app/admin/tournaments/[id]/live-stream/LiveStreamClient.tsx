"use client";

import { useEffect, useRef, useState } from "react";

/** A read-only URL with a Copy button: the OBS browser source's address. */
export function CopyField({ value, label, testId }: { value: string; label: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <p className="label">{label}</p>
      <div className="flex gap-2">
        <input readOnly value={value} className="input min-w-0 flex-1 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} data-testid={testId} />
        <button
          type="button"
          className="btn-secondary text-xs"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(
              () => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              },
              () => setCopied(false),
            );
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/**
 * The overlay as OBS will draw it: the real page at 1920×1080 in an iframe,
 * scaled to the card's width, over a checkerboard so the transparent parts show
 * as transparent.
 */
export function OverlayPreview({ src, title }: { src: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / 1920));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={box}
      className="relative w-full overflow-hidden rounded-lg border border-border"
      style={{
        aspectRatio: "16 / 9",
        backgroundColor: "#cfd4d9",
        backgroundImage:
          "linear-gradient(45deg, #9aa3ab 25%, transparent 25%), linear-gradient(-45deg, #9aa3ab 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #9aa3ab 75%), linear-gradient(-45deg, transparent 75%, #9aa3ab 75%)",
        backgroundSize: "24px 24px",
        backgroundPosition: "0 0, 0 12px, 12px -12px, -12px 0",
      }}
      data-testid="overlay-preview"
    >
      <iframe
        src={src}
        title={title}
        width={1920}
        height={1080}
        style={{ position: "absolute", left: 0, top: 0, width: 1920, height: 1080, border: 0, transform: `scale(${scale})`, transformOrigin: "0 0", background: "transparent" }}
        // The preview is a picture of the overlay: nothing in it is meant to be clicked.
        tabIndex={-1}
        loading="lazy"
      />
    </div>
  );
}
