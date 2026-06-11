import { redirect } from "next/navigation";
import { currentRole, roleForPassword, setSessionCookie } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const HOME: Record<string, string> = {
  admin: "/admin/tournaments",
  manager: "/admin/tournaments",
  referee: "/referee",
  operator: "/operator",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const role = await currentRole();
  if (role) redirect(next || HOME[role]);

  async function login(formData: FormData) {
    "use server";
    const password = String(formData.get("password") ?? "");
    const nextUrl = String(formData.get("next") ?? "");
    const role = roleForPassword(password);
    if (!role) {
      redirect(`/login?error=1${nextUrl ? `&next=${encodeURIComponent(nextUrl)}` : ""}`);
    }
    await setSessionCookie(role);
    await audit({ action: "LOGIN", actor_role: role });
    redirect(nextUrl || HOME[role]);
  }

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <form action={login} className="card w-full max-w-sm space-y-4 p-6">
        <div className="text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">Move Beyond</p>
          <h1 className="text-xl font-bold">Staff Login</h1>
          <p className="mt-1 text-sm text-muted">
            Enter your access code. Admin, manager, referee, and screen operator each have their own code.
          </p>
        </div>
        {error && (
          <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm font-semibold text-danger">
            Wrong access code. Try again.
          </p>
        )}
        <input type="hidden" name="next" value={next ?? ""} />
        <div>
          <label className="label" htmlFor="password">Access code</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoFocus
            className="input text-lg"
            placeholder="••••••••"
          />
        </div>
        <button type="submit" className="btn-primary w-full py-3 text-base">Log in</button>
      </form>
    </main>
  );
}
