"use client";

import { useCallback, useRef, useState } from "react";
import { MB, compressImageFile } from "@/lib/imageCompress";
import { DEFAULT_FOCAL, focalPosition, sizedImageSrc } from "@/lib/portrait";

type Folder = "tournament-player" | "profile-player";

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

/**
 * Pick a player photo and say where the face is.
 *
 * Framing is stored as a focal point rather than baked into a crop, so one
 * upload serves a 28px avatar and a 320px broadcast portrait without either
 * cutting the head off. Uploading happens immediately so the operator sees the
 * result, but nothing is written to the player until the surrounding form is
 * saved — the field only puts values into hidden inputs.
 */
export default function PlayerPhotoField({
  name,
  folder,
  endpoint,
  maxUploadBytes = 4 * MB,
  label = "Photo",
  photoUrl: initialPhoto = null,
  focalX: initialX = DEFAULT_FOCAL[0],
  focalY: initialY = DEFAULT_FOCAL[1],
  size = 128,
}: {
  /** Hidden inputs are emitted as `${name}_photo_url`, `_focal_x`, `_focal_y`. */
  name: string;
  /** Which staff folder to upload into. Ignored when `endpoint` is given. */
  folder?: Folder;
  /** Overrides the staff upload route — used by public self-registration. */
  endpoint?: string;
  /**
   * The limit the endpoint enforces. A phone photo is several times this, so the
   * picked file is shrunk to fit rather than refused.
   */
  maxUploadBytes?: number;
  label?: string;
  photoUrl?: string | null;
  focalX?: number;
  focalY?: number;
  size?: number;
}) {
  const [photo, setPhoto] = useState<string | null>(initialPhoto);
  const [preview, setPreview] = useState<string | null>(null);
  const [focal, setFocal] = useState<[number, number]>([initialX, initialY]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const shown = preview ?? sizedImageSrc(photo, size * 2) ?? photo;

  const upload = useCallback(
    async (picked: File) => {
      setError(null);
      setNote(null);
      // Show the picked file at once; the network round trip comes after.
      setPreview(URL.createObjectURL(picked));
      setBusy(true);
      try {
        // A phone writes 6-12 MB a frame, well past what the endpoint takes, and
        // nobody can shrink it on the phone. So it is shrunk here instead.
        const shrunk = await compressImageFile(picked, { maxBytes: maxUploadBytes, maxEdge: 2400 });
        const file = shrunk.file;
        if (shrunk.note) setNote(shrunk.note);
        const body = new FormData();
        body.append("file", file);
        const res = await fetch(endpoint ?? `/api/media?folder=${folder}`, { method: "POST", body });
        const json = (await res.json()) as { url?: string; error?: string; message?: string };
        if (!res.ok || !json.url) throw new Error(json.error ?? json.message ?? "Upload failed");
        setPhoto(json.url);
        setPreview(null);
      } catch (e) {
        setError((e as Error).message);
        setPreview(null);
      } finally {
        setBusy(false);
      }
    },
    [folder, endpoint, maxUploadBytes],
  );

  /**
   * Measure against the drawn image, not the padded box: a portrait letterboxed
   * inside a square would otherwise map a click on the face to the wrong point.
   */
  function pickFocal(e: React.MouseEvent<HTMLElement>) {
    if (!shown) return;
    const img = e.currentTarget.querySelector("img");
    const box = (img ?? e.currentTarget).getBoundingClientRect();
    setFocal([
      clamp01(Number(((e.clientX - box.left) / box.width).toFixed(3))),
      clamp01(Number(((e.clientY - box.top) / box.height).toFixed(3))),
    ]);
  }

  return (
    <div className="space-y-1">
      <label className="label">{label}</label>

      <input type="hidden" name={`${name}_photo_url`} value={photo ?? ""} />
      <input type="hidden" name={`${name}_focal_x`} value={focal[0]} />
      <input type="hidden" name={`${name}_focal_y`} value={focal[1]} />

      <div className="flex items-start gap-3">
        <div
          role="button"
          tabIndex={0}
          aria-label={shown ? "Click the face to set the framing" : "Choose a photo"}
          onClick={(e) => (shown ? pickFocal(e) : inputRef.current?.click())}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void upload(file);
          }}
          className={`relative shrink-0 cursor-pointer overflow-hidden rounded-xl border-2 border-dashed transition-colors ${
            dragging ? "border-accent bg-accent/10" : "border-border bg-background"
          }`}
          style={{ width: size, height: size }}
        >
          {shown ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={shown}
                alt=""
                className="h-full w-full object-cover"
                style={{ objectPosition: focalPosition({ focalX: focal[0], focalY: focal[1] }) }}
              />
              <span
                aria-hidden
                className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-accent shadow"
                style={{ left: `${focal[0] * 100}%`, top: `${focal[1] * 100}%` }}
              />
              <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/55 py-0.5 text-center text-[10px] font-bold uppercase tracking-wider text-white">
                Click the face
              </span>
            </>
          ) : (
            <span className="flex h-full w-full items-center justify-center px-2 text-center text-[11px] text-muted">
              {busy ? "Uploading…" : "Drop a photo or click"}
            </span>
          )}
          {busy && shown && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/45 text-[11px] font-semibold text-white">
              Uploading…
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap gap-1.5">
            <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => inputRef.current?.click()} disabled={busy}>
              {photo ? "Replace" : "Choose file"}
            </button>
            {photo && (
              <button
                type="button"
                className="btn-secondary px-2 py-1 text-xs text-danger"
                onClick={() => {
                  setPhoto(null);
                  setPreview(null);
                  setFocal([DEFAULT_FOCAL[0], DEFAULT_FOCAL[1]]);
                }}
                disabled={busy}
              >
                Remove
              </button>
            )}
          </div>
          <p className="text-[11px] text-muted">
            Waist-up, even light, at least 800px tall. Click the face so the crop keeps it
            centred on every screen size.
          </p>
          {note && <p className="text-[11px] text-muted" data-testid="photo-compressed">{note}</p>}
          {error && <p className="text-[11px] font-semibold text-danger">{error}</p>}
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void upload(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
