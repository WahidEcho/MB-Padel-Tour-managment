/**
 * Expected refusals of the staff console: a validation message meant for the
 * person who pressed the button ("Type REFUND to confirm.", "A division already
 * has that name."). A server action that throws shows Next.js's error page, and
 * production hides the words, so these are returned as an inline message instead
 * (src/components/StateForm.tsx). Anything else (a guard refusing another
 * organisation's row, a database failure) still throws.
 */

/** What a StateForm's action answers. */
export type FormState = { ok: boolean; message: string } | null;

const BRAND = Symbol.for("mb.refusal");

/** A refusal whose words are meant for the person: shown next to the control, never as an error page. */
export class Refusal extends Error {
  readonly [BRAND] = true;
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

export function isRefusal(err: unknown): err is Refusal {
  return err instanceof Refusal || (typeof err === "object" && err !== null && (err as Record<symbol, unknown>)[BRAND] === true);
}

/** Throws a Refusal (for `cond || refusal("…")`-style checks). */
export function refusal(message: string): never {
  throw new Refusal(message);
}

/**
 * Runs a server action's work and answers its StateForm: the work's own message
 * (or `done`) when it went through, a Refusal's message when it was refused.
 * Everything else, including Next.js's redirect and notFound signals, is rethrown.
 */
export async function formResult(work: () => Promise<string | void>, done = "Saved."): Promise<FormState> {
  try {
    const message = await work();
    return { ok: true, message: message || done };
  } catch (err) {
    if (isRefusal(err)) return { ok: false, message: err.message };
    throw err;
  }
}
