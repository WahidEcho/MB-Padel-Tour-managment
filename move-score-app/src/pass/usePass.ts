/**
 * The phone's event pass. Whose pass it is (the signed-in account, else this
 * phone) is part of the query key, so signing in, out or deleting the account
 * switches to the right pass by itself. The last answer is kept on the phone, so
 * the pass shows at once and offline instead of a sealed pack.
 */
import { useQuery } from "@tanstack/react-query";
import type { MPass } from "@core";
import { api } from "../api/client";
import { queryClient } from "../api/queries";
import { getJson, setJson } from "../state/kv";
import { session, type Session } from "../state/session";

export interface PassReply {
  pass: MPass | null;
}

export function passOwnerOf(s: Session): string | null {
  if (s.user) return `user:${s.user.id}`;
  return s.installToken && s.installationId ? `install:${s.installationId}` : null;
}

export const passKey = (groupId: string | undefined, owner: string | null) => ["pass", groupId, owner] as const;
const savedKey = (groupId: string, owner: string) => `q:pass:${groupId}:${owner}`;

/** Puts a fresh answer from the server in place for the current owner (and on the phone). */
export function rememberPass(groupId: string, reply: PassReply) {
  const owner = passOwnerOf(session.get());
  if (!owner) return;
  setJson(savedKey(groupId, owner), reply);
  queryClient.setQueryData(passKey(groupId, owner), reply);
}

export function usePass(groupId: string | undefined) {
  const owner = session.use(passOwnerOf);
  const q = useQuery<PassReply>({
    queryKey: passKey(groupId, owner),
    queryFn: async () => {
      const r = await api<PassReply>(`/api/mobile/v1/me/pass?group=${groupId}`, { who: "me" });
      setJson(savedKey(groupId!, owner!), r);
      return r;
    },
    initialData: groupId && owner ? getJson<PassReply | undefined>(savedKey(groupId, owner), undefined) : undefined,
    // The saved answer shows at once but counts as old, so it is fetched again straight away.
    initialDataUpdatedAt: 0,
    enabled: Boolean(groupId && owner),
  });
  // Only an answer from the server can say there is no pass; a saved or missing one can't.
  const confirmedNone = q.dataUpdatedAt > 0 && q.data?.pass === null;
  return { ...q, owner, pass: q.data?.pass ?? null, confirmedNone };
}
