/**
 * The name a signed-in person gives themselves on Account ("Edit name and
 * photo"). Pure: shared with the app through `@core`, so the phone shows the same
 * answer before it sends.
 *
 * Plain text, 1–60 characters after trimming and collapsing runs of spaces.
 * Refused: control characters (incl. line breaks and tabs), bidirectional
 * overrides/isolates and other invisible format characters (they can flip or
 * hide what other people read), and markup brackets.
 */

export const DISPLAY_NAME_MAX = 60;

export type DisplayNameCheck = { ok: true; name: string } | { ok: false; error: string };

// C0/C1 controls, and Unicode format characters that change how text is shown:
// soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width and
// directional marks (ZWNJ/ZWJ stay: Persian and Indic names, emoji),
// line/paragraph separators, bidi embeddings/overrides/isolates,
// invisible operators, BOM, interlinear annotations.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const FORMAT = /[\u00AD\u061C\u180E\u200B\u200E\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/;
const MARKUP = /[<>]/;

export function checkDisplayName(input: unknown): DisplayNameCheck {
  if (typeof input !== "string") return { ok: false, error: "Enter your name." };
  if (CONTROL.test(input) || FORMAT.test(input)) return { ok: false, error: "Use letters, numbers and ordinary punctuation only." };
  let normal = input;
  try {
    normal = input.normalize("NFC");
  } catch {
    // An engine without Unicode normalisation (some phones): the text as typed.
  }
  const name = normal.replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, error: "Enter your name." };
  if (MARKUP.test(name)) return { ok: false, error: "Use letters, numbers and ordinary punctuation only." };
  if ([...name].length > DISPLAY_NAME_MAX) return { ok: false, error: `Keep your name to ${DISPLAY_NAME_MAX} characters.` };
  if (!/[\p{L}\p{N}]/u.test(name)) return { ok: false, error: "Enter your name." };
  return { ok: true, name };
}
