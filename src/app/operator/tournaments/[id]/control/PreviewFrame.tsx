"use client";

import { useEffect, useRef, useState } from "react";

/** The iframe renders the wall at this size, then scales down to fit its card. */
const FRAME_W = 1280;
const FRAME_H = 720;

/**
 * A live thumbnail of one wall, scaled to whatever width its card has.
 *
 * A fixed 480px thumbnail was cropped on a laptop, where two cards side by side
 * are narrower than that — the operator saw part of a wall and could not tell.
 * The frame keeps a stable src (a changing one reloads it) and cannot be clicked
 * into: a stray click must not navigate a page a TV is mirroring.
 */
export default function PreviewFrame({ src, title }: { src: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.375);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width / FRAME_W;
      setScale((prev) => (Math.abs(prev - next) > 0.001 ? next : prev));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={box} className="relative w-full overflow-hidden" style={{ aspectRatio: `${FRAME_W} / ${FRAME_H}` }}>
      <iframe
        src={src}
        title={title}
        // `allow-same-origin` is required: without it the framed app cannot
        // refresh itself and the thumbnail silently freezes while looking live.
        sandbox="allow-scripts allow-same-origin"
        tabIndex={-1}
        className="pointer-events-none absolute left-0 top-0 block origin-top-left border-0"
        style={{ width: FRAME_W, height: FRAME_H, transform: `scale(${scale})` }}
      />
    </div>
  );
}
