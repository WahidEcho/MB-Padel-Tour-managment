"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { Group, GroupTeam } from "@/lib/types";
import type { DrawOption } from "@/lib/draws";
import { drawOptions, saveAssignment, toggleLock, publishGroups } from "./actions";

interface TeamLite {
  id: string;
  team_name: string;
  players: string;
}

function TeamCard({
  team,
  locked,
  groupTeamId,
  tournamentId,
  onMove,
}: {
  team: TeamLite;
  locked: boolean;
  groupTeamId?: string;
  tournamentId: string;
  onMove: (dir: -1 | 1) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: team.id,
    disabled: locked,
  });
  return (
    <div
      ref={setNodeRef}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 50 } : undefined}
      className={`flex items-center justify-between gap-1 rounded-xl border border-border bg-background px-2 py-1.5 text-sm ${
        isDragging ? "opacity-70 shadow-lg" : ""
      } ${locked ? "border-warning/60" : ""}`}
    >
      <button
        className={`touch-none px-1 ${locked ? "cursor-not-allowed text-muted" : "cursor-grab"}`}
        {...listeners}
        {...attributes}
        aria-label="Drag team"
      >
        ⠿
      </button>
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">{team.team_name}</p>
        <p className="truncate text-xs text-muted">{team.players}</p>
      </div>
      <div className="flex items-center gap-0.5">
        <button className="px-1 text-muted hover:text-foreground" onClick={() => onMove(-1)} aria-label="Move up">↑</button>
        <button className="px-1 text-muted hover:text-foreground" onClick={() => onMove(1)} aria-label="Move down">↓</button>
        {groupTeamId && (
          <form action={toggleLock}>
            <input type="hidden" name="tournament_id" value={tournamentId} />
            <input type="hidden" name="group_team_id" value={groupTeamId} />
            <button className="px-1" title={locked ? "Unlock team (randomizer can move it)" : "Lock team in this group"}>
              {locked ? "🔒" : "🔓"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function GroupColumn({
  group,
  children,
}: {
  group: Group;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: group.id });
  return (
    <div
      ref={setNodeRef}
      className={`card min-h-32 space-y-1.5 ${isOver ? "border-accent" : ""}`}
    >
      <h3 className="font-bold">
        {group.group_name}{" "}
        <span className={`badge ${group.status === "published" ? "bg-success/15 text-success" : "bg-border text-muted"}`}>
          {group.status}
        </span>
      </h3>
      {children}
    </div>
  );
}

export default function GroupsClient({
  tournamentId,
  groups,
  groupTeams,
  teams,
  published,
  hasMatches,
}: {
  tournamentId: string;
  groups: Group[];
  groupTeams: GroupTeam[];
  teams: TeamLite[];
  published: boolean;
  hasMatches: boolean;
}) {
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const initial = useMemo(
    () =>
      groups.map((g) =>
        groupTeams
          .filter((gt) => gt.group_id === g.id)
          .sort((a, b) => a.position - b.position)
          .map((gt) => gt.team_id)
      ),
    [groups, groupTeams]
  );
  const [assignment, setAssignment] = useState<string[][]>(initial);
  const [dirty, setDirty] = useState(false);
  const [options, setOptions] = useState<DrawOption[] | null>(null);
  const [optionCount, setOptionCount] = useState(5);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const gtByTeam = useMemo(() => new Map(groupTeams.map((gt) => [gt.team_id, gt])), [groupTeams]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 8 } })
  );

  function onDragEnd(e: DragEndEvent) {
    const teamId = String(e.active.id);
    const targetGroupId = e.over?.id ? String(e.over.id) : null;
    if (!targetGroupId) return;
    const targetIndex = groups.findIndex((g) => g.id === targetGroupId);
    if (targetIndex < 0) return;
    setAssignment((prev) => {
      const next = prev.map((g) => g.filter((t) => t !== teamId));
      next[targetIndex] = [...next[targetIndex], teamId];
      return next;
    });
    setDirty(true);
  }

  function moveWithin(groupIndex: number, teamId: string, dir: -1 | 1) {
    setAssignment((prev) => {
      const next = prev.map((g) => [...g]);
      const list = next[groupIndex];
      const i = list.indexOf(teamId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return prev;
      [list[i], list[j]] = [list[j], list[i]];
      return next;
    });
    setDirty(true);
  }

  function loadOptions() {
    startTransition(async () => {
      setOptions(await drawOptions(tournamentId, optionCount));
    });
  }

  function save(next?: string[][]) {
    startTransition(async () => {
      await saveAssignment(tournamentId, next ?? assignment);
      setDirty(false);
      setOptions(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input w-auto"
          value={optionCount}
          onChange={(e) => setOptionCount(Number(e.target.value))}
        >
          {[3, 5, 10].map((n) => (
            <option key={n} value={n}>{n} options</option>
          ))}
        </select>
        <button className="btn-secondary" onClick={loadOptions} disabled={pending}>
          🎲 Generate Draw Options
        </button>
        {dirty && (
          <button className="btn-primary" onClick={() => save()} disabled={pending}>
            Save draw
          </button>
        )}
        <form
          action={publishGroups}
          onSubmit={(e) => {
            const msg = hasMatches
              ? "Changing groups after publishing will regenerate group matches and may affect the schedule. Continue?"
              : "Publish groups and generate the group-stage matches?";
            if (dirty) {
              e.preventDefault();
              alert("Save the draw first.");
              return;
            }
            if (!window.confirm(msg)) e.preventDefault();
          }}
        >
          <input type="hidden" name="tournament_id" value={tournamentId} />
          <button className={published ? "btn-secondary" : "btn-primary"} disabled={pending}>
            {published ? "Republish + regenerate matches" : "Publish groups + generate matches"}
          </button>
        </form>
      </div>

      {options && (
        <div className="card space-y-3 border-accent/40">
          <h3 className="font-bold">Draw options — pick one</h3>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {options.map((opt, oi) => (
              <div key={oi} className="rounded-xl border border-border bg-background p-3">
                <p className="mb-1 text-xs font-bold uppercase text-muted">Option {oi + 1}</p>
                {opt.groups.map((teamIds, gi) => (
                  <p key={gi} className="text-xs">
                    <b>{groups[gi]?.group_name}:</b>{" "}
                    {teamIds.map((t) => teamById.get(t)?.team_name ?? "?").join(", ")}
                  </p>
                ))}
                <button
                  className="btn-primary mt-2 w-full py-1 text-xs"
                  disabled={pending}
                  onClick={() => {
                    setAssignment(opt.groups);
                    save(opt.groups);
                  }}
                >
                  Use this draw
                </button>
              </div>
            ))}
          </div>
          <button className="btn-secondary text-xs" onClick={() => setOptions(null)}>Close options</button>
        </div>
      )}

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {groups.map((group, gi) => (
            <GroupColumn key={group.id} group={group}>
              {assignment[gi]?.map((teamId) => {
                const team = teamById.get(teamId);
                if (!team) return null;
                const gt = gtByTeam.get(teamId);
                return (
                  <TeamCard
                    key={teamId}
                    team={team}
                    locked={gt?.is_locked ?? false}
                    groupTeamId={gt?.id}
                    tournamentId={tournamentId}
                    onMove={(dir) => moveWithin(gi, teamId, dir)}
                  />
                );
              })}
              {assignment[gi]?.length === 0 && (
                <p className="py-4 text-center text-xs text-muted">Drop teams here</p>
              )}
            </GroupColumn>
          ))}
        </div>
      </DndContext>
      <p className="text-xs text-muted">
        Drag teams between groups (or use ↑/↓ to reorder). 🔒 locks a team so the randomizer keeps it in
        its group. Remember to <b>Save draw</b>, then <b>Publish</b> to generate matches.
      </p>
    </div>
  );
}
