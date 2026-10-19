import { redirect } from "next/navigation";
import { COACH_REFUSAL_MESSAGE, currentCoachResolution } from "@/lib/coaches/server";
import { coachSignInAction } from "./actions";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = { ...COACH_REFUSAL_MESSAGE, rate_limited: "Too many attempts. Wait a few minutes and try again." };

/** Coach sign-in on the web: the team's code from its card. Signed in already: straight to My team. */
export default async function CoachSignIn({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const me = await currentCoachResolution();
  if (me.ok) redirect("/coach/team");
  const message = error ? (ERRORS[error] ?? ERRORS.wrong_code) : null;
  return (
    <div className="flex flex-1 items-center justify-center py-10">
      <form action={coachSignInAction} className="card w-full max-w-sm space-y-4 p-6" data-testid="coach-signin">
        <div>
          <h1 className="text-xl font-bold">Team coach sign-in</h1>
          <p className="text-sm text-muted">Type the code on your team&apos;s coach card. Every coach of the team uses the same code.</p>
        </div>
        <div>
          <label className="label" htmlFor="coach-code">Team code</label>
          <input id="coach-code" name="code" className="input w-full font-mono uppercase tracking-widest" placeholder="XXXX-XXXX-XXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false} required maxLength={20} />
        </div>
        {message && <p className="text-sm text-danger" role="alert" data-testid="coach-error">{message}</p>}
        <button className="btn-primary w-full justify-center">Sign in</button>
        <p className="text-xs text-muted">Read only: your own team&apos;s ties, line-ups, live scores and results. Line-ups are entered by the referee.</p>
      </form>
    </div>
  );
}
