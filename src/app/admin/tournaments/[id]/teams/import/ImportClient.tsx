"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { parseTeamsCsv, type CsvTeamRow } from "@/lib/csv";
import { importTeams } from "../actions";

export default function ImportClient({
  tournamentId,
  existingTeamNames,
}: {
  tournamentId: string;
  existingTeamNames: string[];
}) {
  const [rows, setRows] = useState<CsvTeamRow[] | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function onFile(file: File) {
    const text = await file.text();
    setRows(parseTeamsCsv(text));
    setDone(null);
  }

  const valid = (rows ?? []).filter((r) => r.errors.length === 0);
  const existing = new Set(existingTeamNames.map((n) => n.toLowerCase()));

  function confirmImport() {
    startTransition(async () => {
      const imported = await importTeams(
        tournamentId,
        valid.map((r) => ({
          team_name: r.team_name,
          player_1_name: r.player_1_name,
          player_2_name: r.player_2_name,
          player_1_photo_url: r.player_1_photo_url,
          player_2_photo_url: r.player_2_photo_url,
          phone: r.phone,
          notes: r.notes,
        }))
      );
      setDone(imported);
      setRows(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <label className="card block cursor-pointer border-dashed p-8 text-center hover:border-accent">
        <input
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
        />
        <span className="font-semibold">Click to upload your filled CSV file</span>
        <p className="mt-1 text-xs text-muted">team_name, player_1_name, player_2_name are required</p>
      </label>

      {done !== null && (
        <p className="rounded-xl bg-success/10 px-4 py-3 font-semibold text-success">
          Imported {done} team{done === 1 ? "" : "s"} ✓
        </p>
      )}

      {rows && (
        <div className="card space-y-3 overflow-x-auto">
          <h3 className="font-bold">
            Preview — {valid.length} valid row{valid.length === 1 ? "" : "s"}
            {rows.length - valid.length > 0 && (
              <span className="text-danger"> · {rows.length - valid.length} blocked</span>
            )}
          </h3>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-muted">
                <th className="py-1 pr-3">Team</th>
                <th className="py-1 pr-3">Player 1</th>
                <th className="py-1 pr-3">Player 2</th>
                <th className="py-1 pr-3">Phone</th>
                <th className="py-1">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="py-1.5 pr-3 font-semibold">
                    {r.team_name}
                    {existing.has(r.team_name.toLowerCase()) && (
                      <span className="ml-1 badge bg-warning/15 text-warning">duplicate name</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3">{r.player_1_name}</td>
                  <td className="py-1.5 pr-3">{r.player_2_name}</td>
                  <td className="py-1.5 pr-3">{r.phone}</td>
                  <td className="py-1.5">
                    {r.errors.length === 0 ? (
                      <span className="text-success">OK</span>
                    ) : (
                      <span className="text-danger">{r.errors.join(", ")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            className="btn-primary"
            disabled={valid.length === 0 || pending}
            onClick={confirmImport}
          >
            {pending ? "Importing…" : `Confirm import (${valid.length} teams)`}
          </button>
        </div>
      )}
    </div>
  );
}
