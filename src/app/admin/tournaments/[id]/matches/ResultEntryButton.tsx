"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import FinalScoreEntry from "@/components/scoring/FinalScoreEntry";
import type { ChessCompetition } from "@/lib/chess/result";
import type { ResultPayload, ResultProblem } from "@/lib/scoring/resultEntry";
import type { MatchRules } from "@/lib/types";
import { enterMatchResult } from "./actions";

/** The organiser's "Result" button on a match row: the shared entry form in a dialog. */
export default function ResultEntryButton(props: {
  tournamentId: string;
  matchId: string;
  engine: "games" | "chess";
  rules: MatchRules;
  legs: 1 | 2;
  competition: ChessCompetition;
  sideA: string;
  sideB: string;
  initial: ResultPayload | null;
  correcting: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<ResultProblem[] | null>(null);
  const [pending, startTransition] = useTransition();
  // A fresh form each time the dialog opens.
  const [round, setRound] = useState(0);

  function submit(payload: ResultPayload) {
    startTransition(async () => {
      try {
        const out = await enterMatchResult(props.tournamentId, props.matchId, payload);
        if (out.ok) {
          setOpen(false);
          router.refresh();
          return;
        }
        setError(out.error);
        setProblems(out.problems ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "The result was not recorded.");
        setProblems(null);
      }
    });
  }

  return (
    <>
      <button
        type="button"
        className="btn-secondary px-2 py-1 text-xs"
        onClick={() => {
          setError(null);
          setProblems(null);
          setRound((r) => r + 1);
          setOpen(true);
        }}
        data-testid={`result-${props.matchId}`}
      >
        {props.correcting ? "Correct result" : "Result"}
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="card w-full max-w-sm space-y-3 bg-card">
            <FinalScoreEntry
              key={round}
              engine={props.engine}
              rules={props.rules}
              legs={props.legs}
              competition={props.competition}
              sideA={props.sideA}
              sideB={props.sideB}
              initial={props.initial}
              correcting={props.correcting}
              canDecideAdvance
              busy={pending}
              error={error}
              problems={problems}
              onSubmit={submit}
              onCancel={() => setOpen(false)}
            />
          </div>
        </div>
      )}
    </>
  );
}
