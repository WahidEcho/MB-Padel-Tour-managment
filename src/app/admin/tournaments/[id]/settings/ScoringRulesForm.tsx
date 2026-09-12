"use client";

import { useActionState } from "react";
import { STAGE_RULE_LABELS, describeMatchRules, scoringConfigForMatch } from "@/lib/scoring/rules";
import type { FormatConfig, ScoringConfig, Stage, StageRuleKey } from "@/lib/types";
import { updateScoring, type ScoringFormState } from "./actions";

/** The buckets shown for the Cup (or a tournament running a single bracket). */
const CUP_KEYS: StageRuleKey[] = ["group", "quarter_semi", "final", "bracket"];
const PLATE_KEYS: StageRuleKey[] = ["plate_quarter_semi", "plate_final", "plate_bracket"];

const STAGE_FOR_KEY: Record<StageRuleKey, Stage> = {
  group: "group",
  quarter_semi: "semi_final",
  final: "final",
  bracket: "knockout",
  plate_quarter_semi: "semi_final",
  plate_final: "final",
  plate_bracket: "knockout",
};

const HINT: Record<StageRuleKey, string> = {
  group: "Every group match.",
  quarter_semi: "Quarter-finals, semi-finals and the third-place match — the rounds usually shortened together.",
  final: "The final alone.",
  bracket: "Round of 16 and any earlier knockout round.",
  plate_quarter_semi: "Leave blank to match the Cup.",
  plate_final: "Leave blank to match the Cup.",
  plate_bracket: "Leave blank to match the Cup.",
};

function StagePanel({
  ruleKey,
  scoring,
}: {
  ruleKey: StageRuleKey;
  scoring: ScoringConfig;
}) {
  const over = scoring.stageOverrides?.[ruleKey] ?? {};
  const set = Object.keys(over).length;
  const tier = ruleKey.startsWith("plate_") ? "plate" : "cup";
  const resolved = scoringConfigForMatch(
    { scoring_config: scoring },
    { stage: STAGE_FOR_KEY[ruleKey] },
    tier,
  );
  const f = (field: string) => `ov.${ruleKey}.${field}`;

  return (
    <details className="rounded-xl border border-border" open={set > 0}>
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
        {STAGE_RULE_LABELS[ruleKey]}
        {set > 0 ? (
          <span className="badge ml-2 bg-accent/15 text-accent">{set} override{set > 1 ? "s" : ""}</span>
        ) : (
          <span className="ml-2 text-xs font-normal text-muted">inherits</span>
        )}
      </summary>
      <div className="space-y-2 border-t border-border p-3">
        <p className="text-xs text-muted">{HINT[ruleKey]}</p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Sets to win match</label>
            <input name={f("setsToWinMatch")} type="number" min={1} max={3} defaultValue={over.setsToWinMatch ?? ""} placeholder="inherit" className="input" />
          </div>
          <div>
            <label className="label">Games to win set</label>
            <input name={f("gamesToWinSet")} type="number" min={1} max={9} defaultValue={over.gamesToWinSet ?? ""} placeholder="inherit" className="input" />
          </div>
          <div>
            <label className="label">Tie-break at games</label>
            <input name={f("tiebreakAtGames")} type="number" min={1} max={20} defaultValue={over.tiebreakAtGames ?? ""} placeholder="inherit" className="input" />
          </div>
          <div>
            <label className="label">Tie-break target points</label>
            <input name={f("tiebreakTargetPoints")} type="number" min={1} max={21} defaultValue={over.tiebreakTargetPoints ?? ""} placeholder="inherit" className="input" />
          </div>
          <div>
            <label className="label">Tie-break</label>
            {/* Three-state, not a checkbox: an unchecked box sends nothing, which
                would be indistinguishable from "inherit". */}
            <select name={f("tiebreakEnabled")} defaultValue={over.tiebreakEnabled === undefined ? "" : over.tiebreakEnabled ? "on" : "off"} className="input">
              <option value="">Inherit</option>
              <option value="on">Enabled</option>
              <option value="off">Disabled</option>
            </select>
          </div>
          <div>
            <label className="label">Tie-break win by two</label>
            <select name={f("tiebreakWinByTwo")} defaultValue={over.tiebreakWinByTwo === undefined ? "" : over.tiebreakWinByTwo ? "on" : "off"} className="input">
              <option value="">Inherit</option>
              <option value="on">Yes</option>
              <option value="off">No</option>
            </select>
          </div>
          <div className="col-span-2">
            <label className="label">Walkover score</label>
            <input name={f("walkoverScore")} defaultValue={over.walkoverScore ?? ""} placeholder="inherit" className="input" />
          </div>
        </div>
        <p className="text-xs text-muted">
          Plays as: <span className="font-semibold text-foreground">{describeMatchRules(resolved)}</span>
        </p>
      </div>
    </details>
  );
}

export default function ScoringRulesForm({
  tournamentId,
  scoring,
  format,
  plateEnabled,
}: {
  tournamentId: string;
  scoring: ScoringConfig;
  format: FormatConfig;
  plateEnabled: boolean;
}) {
  const [state, action, pending] = useActionState<ScoringFormState, FormData>(updateScoring, null);

  return (
    <form action={action} className="card space-y-3">
      <h2 className="font-bold">Scoring &amp; format rules</h2>
      <input type="hidden" name="tournament_id" value={tournamentId} />

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="label">Sets to win match</label>
          <input name="setsToWinMatch" type="number" min={1} max={3} defaultValue={scoring.setsToWinMatch} className="input" />
        </div>
        <div>
          <label className="label">Games to win set</label>
          <input name="gamesToWinSet" type="number" min={1} max={9} defaultValue={scoring.gamesToWinSet} className="input" />
        </div>
        <div>
          <label className="label">Tie-break at games</label>
          <input name="tiebreakAtGames" type="number" min={1} max={20} defaultValue={scoring.tiebreakAtGames} className="input" />
        </div>
        <div>
          <label className="label">Tie-break target points</label>
          <input name="tiebreakTargetPoints" type="number" min={1} max={21} defaultValue={scoring.tiebreakTargetPoints} className="input" />
        </div>
        <div>
          <label className="label">Walkover score</label>
          <input name="walkoverScore" defaultValue={scoring.walkoverScore} className="input" />
        </div>
        <div>
          <label className="label">Qualify per group</label>
          <input name="qualifyPerGroup" type="number" min={1} max={4} defaultValue={format.qualifyPerGroup} className="input" />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="tiebreakEnabled" defaultChecked={scoring.tiebreakEnabled} className="h-4 w-4" />
        Tie-break enabled
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="tiebreakWinByTwo" defaultChecked={scoring.tiebreakWinByTwo} className="h-4 w-4" />
        Tie-break win by two
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="thirdPlaceMatch" defaultChecked={format.thirdPlaceMatch} className="h-4 w-4" />
        Third-place match
      </label>
      <div>
        <label className="label">Cup podium places</label>
        <select name="cupPodiumDepth" defaultValue={String(format.tiers?.cup?.podiumDepth ?? 3)} className="input">
          <option value="1">Champion only</option>
          <option value="2">Champion and runner-up</option>
          <option value="3">Top three</option>
          <option value="4">Top four</option>
        </select>
        <p className="mt-1 text-xs text-muted">
          Third and fourth place only exist when a third-place match is played, so a deeper podium needs
          that switched on.
        </p>
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <div>
          <h3 className="text-sm font-bold">Plate bracket</h3>
          <p className="text-xs text-muted">
            A second knockout for the teams placed below the Cup places, so nobody goes home after the
            group stage. Off by default.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="plateEnabled" defaultChecked={plateEnabled} className="h-4 w-4" />
          Run a Plate bracket
        </label>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Plate places per group</label>
            <input
              name="platePerGroup"
              type="number"
              min={1}
              max={4}
              defaultValue={format.tiers?.plate?.perGroup ?? 2}
              className="input"
            />
          </div>
          <div>
            <label className="label">Plate podium places</label>
            <select name="platePodiumDepth" defaultValue={String(format.tiers?.plate?.podiumDepth ?? 3)} className="input">
              <option value="1">Champion only</option>
              <option value="2">Champion and runner-up</option>
              <option value="3">Top three</option>
              <option value="4">Top four</option>
            </select>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="plateThirdPlaceMatch"
            defaultChecked={format.tiers?.plate?.thirdPlaceMatch ?? format.thirdPlaceMatch ?? true}
            className="h-4 w-4"
          />
          Plate third-place match
        </label>
      </div>
      <div className="space-y-2 border-t border-border pt-3">
        <div>
          <h3 className="text-sm font-bold">Rules per stage</h3>
          <p className="text-xs text-muted">
            Each stage can differ from the tournament default above. Leave a field
            blank to inherit it.
          </p>
        </div>
        {CUP_KEYS.map((k) => (
          <StagePanel key={k} ruleKey={k} scoring={scoring} />
        ))}
        {plateEnabled && (
          <>
            <p className="pt-1 text-xs font-semibold uppercase tracking-widest text-muted">Plate bracket</p>
            {PLATE_KEYS.map((k) => (
              <StagePanel key={k} ruleKey={k} scoring={scoring} />
            ))}
          </>
        )}
      </div>

      {state && !state.ok && (
        <ul className="space-y-1 rounded-xl bg-danger/10 p-3 text-xs text-danger">
          {state.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {state?.ok && <p className="text-xs font-semibold text-success">Saved.</p>}

      <button className="btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Save scoring rules"}
      </button>
    </form>
  );
}
