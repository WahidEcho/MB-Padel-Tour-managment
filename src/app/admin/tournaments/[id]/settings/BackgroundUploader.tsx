"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BACKGROUND_ACCEPT, BACKGROUND_DIMS, BACKGROUND_TYPES, DEFAULT_DIM, backgroundProblem } from "@/lib/background";
import type { EventBackground } from "@/lib/types";
import { finishBackgroundUpload, prepareBackgroundUpload } from "./actions";

/** Some systems hand over an SVG or a WebM with no type; the extension decides then. */
function typeOf(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return Object.entries(BACKGROUND_TYPES).find(([, t]) => t.ext === ext || (ext === "jpeg" && t.ext === "jpg"))?.[0] ?? "";
}

/** PUTs the file to the signed link, reporting progress. */
function sendFile(url: string, file: File, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("network"));
    const body = new FormData();
    body.append("cacheControl", "31536000");
    body.append("", file, file.name);
    xhr.send(body);
  });
}

/**
 * The event background: a GIF, an animated SVG, WebP or PNG, a picture, or a short
 * video loop, behind every TV screen and optionally the public pages.
 *
 * The file uploads on its own the moment it is picked — straight to storage, with
 * a progress bar, because a video is too large to go through the branding form.
 * How it is shown (darkening, public pages) and removing it are saved with the form.
 */
export default function BackgroundUploader({
  tournamentId,
  background,
  returnPath,
}: {
  tournamentId: string;
  background: EventBackground | undefined;
  returnPath?: string;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<"idle" | "uploading" | "checking">("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const busy = phase !== "idle";

  async function upload(picked: File) {
    const type = typeOf(picked);
    const problem = backgroundProblem({ type, size: picked.size });
    if (problem) {
      setMessage({ ok: false, text: problem });
      return;
    }
    // Stored with the right type even when the system did not name one.
    const file = picked.type === type ? picked : new File([picked], picked.name, { type });
    setMessage(null);
    setProgress(0);
    setPhase("uploading");
    try {
      const ticket = await prepareBackgroundUpload(tournamentId, { type, size: file.size });
      if (!ticket.ok) {
        setMessage({ ok: false, text: ticket.message });
        return;
      }
      try {
        await sendFile(ticket.signedUrl, file, setProgress);
      } catch {
        setMessage({ ok: false, text: "The upload stopped. Check the connection and pick the file again." });
        return;
      }
      setPhase("checking");
      const result = await finishBackgroundUpload(tournamentId, ticket.path, returnPath);
      setMessage({ ok: result.ok, text: result.message });
      if (result.ok) router.refresh();
    } catch {
      setMessage({ ok: false, text: "Could not upload the background. Try again." });
    } finally {
      setPhase("idle");
    }
  }

  return (
    <fieldset className="space-y-3 rounded-xl border border-border p-3" data-testid="background-uploader">
      <legend className="px-1 text-sm font-bold">Event background — moves behind every TV screen</legend>
      <div className="flex flex-wrap items-start gap-3">
        <div className="relative flex h-24 w-40 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-[#0b0b0b]">
          {background ? (
            background.kind === "video" ? (
              <video
                key={background.url}
                src={background.url}
                className="h-full w-full object-cover"
                autoPlay
                muted
                loop
                playsInline
                data-testid="background-preview"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={background.url} src={background.url} alt="" className="h-full w-full object-cover" data-testid="background-preview" />
            )
          ) : (
            <span className="px-2 text-center text-[11px] text-white/60">No background yet</span>
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-xs text-muted">
            A GIF, an animated SVG, an animated WebP or PNG, a picture, or a short MP4 or WebM loop (no sound). Up to 50 MB
            for GIF and video, 2 MB for SVG. For a TV, 1920 × 1080 looks sharpest; a video under 15 MB loads quickly.
          </p>
          <input
            type="file"
            accept={BACKGROUND_ACCEPT}
            className="input text-xs"
            disabled={busy}
            data-testid="background-file"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
          {phase === "uploading" && (
            <div className="space-y-1" aria-live="polite">
              <div className="h-2 overflow-hidden rounded-full bg-border">
                <div className="h-full bg-accent transition-[width]" style={{ width: `${progress}%` }} />
              </div>
              <p className="text-xs text-muted">Uploading… {progress}%</p>
            </div>
          )}
          {phase === "checking" && <p className="text-xs text-muted">Checking the file…</p>}
          {message && (
            <p className={`text-xs ${message.ok ? "text-success" : "text-danger"}`} role={message.ok ? "status" : "alert"} data-testid="background-message">
              {message.text}
            </p>
          )}
        </div>
      </div>

      {background && (
        <div className="grid gap-2 sm:grid-cols-2">
          {/* Which background these settings were shown for; the server applies them only to that one. */}
          <input type="hidden" name="background_url" value={background.url} />
          <div>
            <label className="label">Darken behind the content</label>
            <select name="background_dim" defaultValue={background.dim ?? DEFAULT_DIM} className="input" key={`dim-${background.url}`}>
              {BACKGROUND_DIMS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col justify-end gap-2">
            <input type="hidden" name="background_public" value="off" />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="background_public"
                value="on"
                defaultChecked={background.showOnPublic}
                key={`public-${background.url}`}
                className="h-4 w-4"
              />
              Also behind the public pages
            </label>
            {/* Keyed like the other controls: a tick meant for the old background must
                not carry over to one uploaded since. */}
            <label className="flex items-center gap-2 text-xs text-danger">
              <input type="checkbox" name="background_remove" key={`remove-${background.url}`} /> Remove the background
            </label>
          </div>
          <p className="text-xs text-muted sm:col-span-2">Darkening and the public pages are saved with “Save branding”.</p>
        </div>
      )}
    </fieldset>
  );
}
