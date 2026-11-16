"use client";
// W5 app PR A, Task 3 (X-BD-6, FX-G15; owner R24 pick 6 option A): the inline Add match form's Round select. Defaults to the latest round where
// neither side plays (`adhocRoundPlan`, the SAME planner the server defaults by); offers every round the match may go in plus the new round;
// lists a round where a side already plays with its reason, unselectable, and folds a long run of them into one range line.
import { adhocRoundOptions, adhocRoundPlan, chosenAdhocRound, type AdhocRoundRow } from "@/lib/adhoc-round";
import type { MessageKey } from "@/lib/messages";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function AddMatchRoundSelect({
  msg,
  rows,
  home,
  away,
  entrantNames,
  pick,
  onPick,
}: {
  msg: Msg;
  /** The stage's fixtures as the planner reads them (`seats`: the line still counts in its round: not voided, not a withdrawal's expunge). */
  rows: readonly AdhocRoundRow[];
  home: string;
  away: string;
  entrantNames: Readonly<Record<string, string>>;
  /** The person's pick, or null for the default. */
  pick: number | null;
  onPick: (round: number) => void;
}) {
  const ready = home !== "" && away !== "" && home !== away;
  const plan = ready ? adhocRoundPlan(rows, home, away) : null;
  const value = plan === null ? "" : String(chosenAdhocRound(plan, pick));
  const name = (id: string) => entrantNames[id] ?? id;
  return (
    <label className="label flex min-w-0 max-w-full flex-col gap-1 text-xs">
      {msg("stage.addMatch.round")}
      <select
        data-testid="add-match-round"
        className="input min-h-11 w-full min-w-0 max-w-full py-1.5 text-sm"
        value={value}
        disabled={!ready}
        title={ready ? undefined : msg("stage.addMatch.round.pickSides")}
        onChange={(e) => onPick(Number(e.target.value))}
      >
        {plan === null && <option value="" />}
        {plan !== null &&
          adhocRoundOptions(plan).map((o) => {
            if (o.kind === "clashRange") {
              return (
                <option key={`range-${o.from}`} value="" disabled>
                  {msg("stage.addMatch.round.clashRange", { from: o.from, to: o.to })}
                </option>
              );
            }
            if (o.kind === "clash") {
              return (
                <option key={o.round_no} value={o.round_no} disabled>
                  {o.opponentId === null
                    ? msg("stage.addMatch.round.clashAlone", { n: o.round_no, name: name(o.entrantId) })
                    : msg("stage.addMatch.round.clash", { n: o.round_no, name: name(o.entrantId), opponent: name(o.opponentId) })}
                </option>
              );
            }
            const key =
              o.kind === "new"
                ? o.suggested ? "stage.addMatch.round.newSuggested" : "stage.addMatch.round.new"
                : o.suggested ? "stage.addMatch.round.freeSuggested" : "stage.addMatch.round.free";
            return (
              <option key={o.round_no} value={o.round_no}>
                {msg(key, { n: o.round_no })}
              </option>
            );
          })}
      </select>
    </label>
  );
}
