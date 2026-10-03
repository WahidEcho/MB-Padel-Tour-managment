"use server";

import { finishFromAccessToken, resetWithLink, type ResetState } from "@/lib/auth/links";

/** The confirm page, for a link that arrived with its session in the URL fragment. */
export async function finishFromFragment(accessToken: string): Promise<boolean> {
  return finishFromAccessToken(accessToken);
}

/** The reset page's form. */
export async function resetPassword(_prev: ResetState, form: FormData): Promise<ResetState> {
  const s = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v : null;
  };
  return resetWithLink({
    tokenHash: s("token_hash"),
    type: s("type"),
    accessToken: s("access_token") || null,
    password: s("password") ?? "",
    confirm: s("confirm") ?? "",
  });
}
