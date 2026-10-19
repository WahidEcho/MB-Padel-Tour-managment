import { useQuery } from "@tanstack/react-query";
import type { LineupPickerModel } from "@core";
import { api, ApiError } from "../api/client";
import { session } from "../state/session";
import { Body } from "../ui/Text";
import { LoadState } from "../ui/LoadState";
import { LineupPicker } from "./LineupPicker";

/**
 * Loads a tie's line-up picker for a rubber. Court referees (their court), master
 * referees and the organiser get the picker; anyone else (a whole-event code) is
 * told the court referee or the desk enters it. `onSaved`: the console reloads.
 */
export function LineupScreenBody({ matchId, onSaved, fallback }: { matchId: string; onSaved?: () => void; fallback?: string }) {
  const staff = session.use((s) => s.staff);
  const q = useQuery({
    queryKey: ["lineup", matchId, staff?.token],
    queryFn: () => api<LineupPickerModel>(`/api/mobile/v1/referee/matches/${matchId}/lineup`, { who: "staff" }),
    enabled: Boolean(staff && matchId),
    retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
  });
  if (q.error instanceof ApiError && (q.error.status === 403 || q.error.status === 404)) {
    return <Body tone="ink2">{fallback ?? q.error.message}</Body>;
  }
  if (!q.data) return <LoadState compact queries={[q]} what="the line-ups" />;
  return <LineupPicker key={q.dataUpdatedAt} initial={q.data} onSaved={() => onSaved?.()} />;
}
