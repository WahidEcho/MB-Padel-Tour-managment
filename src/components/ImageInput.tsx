"use client";

import { useEffect, useRef, useState } from "react";
import { DEFAULT_TARGET, compressImageFile, type CompressTarget } from "@/lib/imageCompress";

/**
 * A file picker that shrinks an oversized picture before the form sends it.
 *
 * Drop-in for `<input type="file" accept="image/*">`. The chosen file is
 * re-encoded to fit the upload limit and put back into the input, so the form —
 * and the server action behind it — see an ordinary, small file and need no
 * changes at all. A file that already fits, an animation, or a type that cannot
 * be re-encoded is passed through untouched.
 *
 * Writing back needs `DataTransfer`, which every browser this app supports has.
 * If one does not, the original file stays selected and the server's own limit
 * answers, as it did before.
 */
export default function ImageInput({
  name,
  accept = "image/*",
  multiple = false,
  className = "input text-xs",
  disabled,
  target = DEFAULT_TARGET,
  onPicked,
  "data-testid": testId,
}: {
  name?: string;
  accept?: string;
  multiple?: boolean;
  className?: string;
  disabled?: boolean;
  /** The limit to fit inside. Defaults to the staff forms' 4 MB. */
  target?: CompressTarget;
  /** Called with the finished files, for a field that uploads them itself. */
  onPicked?: (files: File[]) => void;
  "data-testid"?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);

  // Shrinking a 12 MB photo takes a second or two. A save pressed in that window
  // would send the original, be refused for its size, and look like the picker
  // had done nothing — so the form simply does not submit until it is done. The
  // "Compressing the picture…" line below says why.
  useEffect(() => {
    const form = ref.current?.form;
    if (!form || !busy) return;
    const block = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    form.addEventListener("submit", block, true);
    return () => form.removeEventListener("submit", block, true);
  }, [busy]);

  async function handle(picked: FileList) {
    const files = Array.from(picked);
    setNotes([]);
    setBusy(true);
    try {
      const results = await Promise.all(files.map((f) => compressImageFile(f, target)));
      const lines = results.flatMap((r, i) =>
        r.note ? [files.length > 1 ? `${files[i].name}: ${r.note}` : r.note] : [],
      );
      if (results.some((r) => r.changed) && ref.current) {
        try {
          const bag = new DataTransfer();
          for (const r of results) bag.items.add(r.file);
          ref.current.files = bag.files;
        } catch {
          // Left as picked; the server answers with its own limit.
        }
      }
      setNotes(lines);
      onPicked?.(results.map((r) => r.file));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input
        ref={ref}
        type="file"
        name={name}
        accept={accept}
        multiple={multiple}
        className={className}
        disabled={disabled || busy}
        data-testid={testId}
        onChange={(e) => {
          const files = e.target.files;
          if (files && files.length > 0) void handle(files);
        }}
      />
      {busy && (
        <p className="mt-1 text-xs text-muted" aria-live="polite">
          Compressing the picture…
        </p>
      )}
      {notes.map((note) => (
        <p key={note} className="mt-1 text-xs text-muted" data-testid="image-compressed">
          {note}
        </p>
      ))}
    </>
  );
}
