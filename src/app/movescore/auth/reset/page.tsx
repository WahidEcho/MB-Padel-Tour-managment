import type { Metadata } from "next";
import { PageTitle } from "../../legal";
import { ResetForm } from "./ResetForm";

export const metadata: Metadata = {
  title: "Choose a new password",
  robots: { index: false },
};

type Search = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/**
 * Where the "reset your password" email lands: `?token_hash=…&type=recovery`.
 * The token is spent only when the form is sent (so an email scanner opening the
 * link does not use it up), then the new password is set on the server and the
 * person goes back to the app to sign in.
 */
export default async function ResetPassword({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  return (
    <>
      <PageTitle eyebrow="Move Score" title="Choose a new password" intro={<p>For your Move Score account. Then go back to the app and sign in with it.</p>} />
      <ResetForm tokenHash={one(q.token_hash)} type={one(q.type)} />
    </>
  );
}
