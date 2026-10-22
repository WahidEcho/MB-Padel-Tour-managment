/**
 * The stories routes' shared answers: who is calling (a signed-in account for
 * anything but reading), and the refusal shape the app reads ({ error, code }).
 */
import { ownerOf, type Owner } from "@/lib/mobile/identity";
import { bearerOf } from "@/lib/auth/accounts";
import { privateJson } from "@/lib/mobile/http";
import type { Refused } from "./server";

/** The signed-in account, or null (an install token alone is not enough to post or interact). */
export async function storyUser(request: Request): Promise<{ userId: string; token: string } | null> {
  const { owner } = await ownerOf(request);
  const token = bearerOf(request);
  if (owner?.kind !== "user" || !token) return null;
  return { userId: owner.id, token };
}

/** The account, else the phone (views count either). */
export async function storyViewer(request: Request): Promise<Owner | null> {
  return (await ownerOf(request)).owner;
}

export const signInFirst = () => privateJson({ error: "Sign in to post and react to stories.", code: "sign_in" }, 401);

export const refusedJson = (r: Refused) => privateJson({ error: r.error, code: r.code }, r.status);
