// W2e Task 24 (G12, INV §5, spec §10; rule X-SE-1 / D3 (1) / D12 / D13): a sanction that ENDS a match. One generic
// builder and witness for every module that declares `sanctionEnding` (badminton's black card, tennis's default,
// volleyball's incomplete-team question), because the declaration is the engine's own and the two kernels that carry it
// fold the same shapes: a sanction event `{by, level}` (the module's `sanctionEnding.eventType`), recorded after START and
// some play, then the `core.forfeit` that ends the match - against the sanctioned side, with the reason the LEVEL calls for.
//
// Nothing here is typed from the rulebook: the sport list is the modules' declarations, the event type is
// `decl.eventType`, and the forfeit REASON is asked of the engine's own D13 rule (`scorerMayForfeit`: `disqualified` after
// an end level, `retired` after a prompt level), so a declaration that moves moves the stream with it.
import { FORFEIT_REASONS, scorerMayForfeit, type SanctionEndingDecl } from "@seazn/engine/core";
import { sportModule } from "../sport-cfg.ts";
import { evidenceState, type FoldEvidence, type ForfeitReason, type Side, type StreamEvent } from "./types.ts";

/** The module's declaration of the sanction levels that end a match or prompt its ending, or null when it declares none
 *  (table tennis's cards, football's, hockey's suspensions: none of them ends a match). */
export function sanctionDeclOf(sportKey: string): SanctionEndingDecl | null {
  return sportModule(sportKey).sanctionEnding ?? null;
}

/** The forfeit reason that ENDS the match after a sanction at `level`, or null when the level ends nothing (a record, or a
 *  sport that declares no ending). Read from the engine's own D13 rule over every reason of the closed forfeit vocabulary:
 *  the one reason a scorer may append right after that sanction. More than one is a defect of the declaration, named. */
export function endingReasonOf(sportKey: string, level: string): ForfeitReason | null {
  const module = sportModule(sportKey);
  const decl = module.sanctionEnding;
  if (decl === undefined) return null;
  const sanction = { type: decl.eventType, payload: { by: "side", level } };
  const reasons = FORFEIT_REASONS.filter((reason) => scorerMayForfeit(module, sanction, { by: "side", reason }));
  if (reasons.length > 1) throw new Error(`streams: ${sportKey}'s '${level}' sanction admits several endings (${reasons.join(", ")}) - its sanctionEnding declaration names the level twice`);
  return reasons[0] ?? null;
}

/** The level a scenario sanctions at: the sport's first END level, else its first PROMPT level that ends a match (volleyball's
 *  incomplete-team question has no end level; its 'expulsion' ends the match as a retirement), else null. Read from the
 *  declaration and the engine's ending rule, never typed. */
export function endingLevelOf(sportKey: string): string | null {
  const decl = sanctionDeclOf(sportKey);
  if (decl === null) return null;
  return [...decl.endLevels, ...decl.promptLevels].find((level) => endingReasonOf(sportKey, level) !== null) ?? null;
}

/** The sanction event: the module's own type, against `by` (an entrant id) at `level`. A team sanction (no `person`). */
export function sanctionToken(sportKey: string, by: string, level: string): StreamEvent {
  const decl = sanctionDeclOf(sportKey);
  if (decl === null) throw new Error(`streams: ${sportKey} declares no sanction event`);
  return { type: decl.eventType, payload: { by, level } };
}

/** What the witness holds an outcome to: the engine's `MatchOutcome` (the local fold) or the product's `ObservedOutcome`
 *  (the fixture row), which share these fields. */
export interface AwardLike {
  readonly kind: string;
  readonly winner?: string;
  readonly loser?: string | null;
  readonly reason?: string;
}

/** What a sanction-ending witness reads: the outcome (the local fold's, or the product's) and the evidence for the
 *  state, named as `FoldEvidence` is - never inferred. */
export interface SanctionFold {
  readonly sportKey: string;
  readonly outcome: AwardLike;
  readonly evidence: FoldEvidence;
}

/** The sanction the match was ended by: whom it was against (`by`, a side), the level, and the two entrants' ids. */
export interface SanctionAsk {
  readonly by: Side;
  readonly level: string;
  readonly home: string;
  readonly away: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Did the match end by the asked sanction? Judged on the OUTCOME (an award to the other side, against the sanctioned one, for
 *  the reason the engine's ending rule gives the level) AND on the STATE the evidence carries: the match is done, its own
 *  outcome is that award, and its LAST sanction is the asked one, against the asked side. A plain forfeit with the same reason
 *  (no sanction on record), a sanction at another level or against the other side, and a state that ended another way all
 *  fail. The state is the local strict fold's for the generator's own request match, or the PRODUCT's for the scenario check -
 *  two entry points, one rule. */
export function sanctionEndWitness(fold: SanctionFold, ask: SanctionAsk): boolean {
  const reason = endingReasonOf(fold.sportKey, ask.level);
  if (reason === null) return false;
  const by = ask.by === "home" ? ask.home : ask.away;
  const winner = ask.by === "home" ? ask.away : ask.home;
  const o = fold.outcome;
  if (o.kind !== "award" || o.winner !== winner || o.loser !== by || o.reason !== reason) return false;
  const st = evidenceState(fold.evidence);
  if (!isRecord(st) || st.phase !== "done") return false;
  const own = st.outcome;
  if (!isRecord(own) || own.kind !== "award" || own.winner !== winner || own.loser !== by || own.reason !== reason) return false;
  // The sanction side names are the kernel's sides; the entrants say which id sits on which.
  if (!isRecord(st.entrants) || st.entrants.home !== ask.home || st.entrants.away !== ask.away) return false;
  const sanctions = st.sanctions;
  if (!Array.isArray(sanctions) || sanctions.length === 0) return false;
  const last: unknown = sanctions[sanctions.length - 1];
  return isRecord(last) && last.by === ask.by && last.level === ask.level;
}
