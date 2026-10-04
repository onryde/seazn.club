// The mixed-driver ledger (W1c Task 6; ruling 15, design §6.2). A browser run
// drives every distinct organiser action TYPE it invokes through the UI at
// least once and the remaining calls of that type over HTTP. This ledger is
// the proof it did (Review Focus 1): a type the case invoked that never ran in
// the browser reds the case on `mixed-driver-coverage`, by name — a page
// object that quietly fell back to HTTP can never read as a browser green.
// The one way past that is an exemption, which carries the route (lib/routing.ts)
// to the wave that owns the missing organiser path (D7: the API-only rows).
//
// Pure: no browser, no HTTP. BrowserDriver asks `wantsBrowser` before each
// organiser action, `record`s the path it took, and returns `coverage()` among
// its checks.
import type { CheckResult } from "../results.ts";
import { WAVE_ID, type Route } from "../routing.ts";

export const ACTION_TYPES = ["createCompetition", "createDivision", "addEntrants", "start", "generate", "score", "forfeit", "withdraw", "completeStage", "standingsView", "publicView"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export type Via = "browser" | "http";
export type PadPolicy = "first" | "all";

const DECLARED: ReadonlySet<string> = new Set(ACTION_TYPES);

function assertType(a: string): asserts a is ActionType {
  if (!DECLARED.has(a)) throw new Error(`mixed: '${a}' is not an action type (declared: ${ACTION_TYPES.join(", ")})`);
}

/** Ruling 47: setup filler — HTTP by design in every layer, never an organiser
 *  action type (no browser turn is owed), recorded so a report shows it ran. */
export const FILLER = ["setMembers", "putLineup", "entrantMembers", "confirmSeedProposal", "recomputeSeedProposal", "challenge", "americanoView"] as const;
export type FillerName = (typeof FILLER)[number];
const FILLERS: ReadonlySet<string> = new Set(FILLER);

/** O-1 (W1c Task 8 review): action types whose browser turn is used up only
 *  once a browser call CREATED something — the value names that path for
 *  coverage's note. A case's first generate follows Start, which for a league
 *  has already seeded every fixture, so it is a no-op: first-only never drove
 *  generateUi's create-fixtures branch live (AGENTS class 1). */
export const CREATE_PATHS: Readonly<Partial<Record<ActionType, string>>> = Object.freeze({
  generate: "the create-fixtures path (stage-rail.ts generateUi)",
});

/** `answered`: browser calls whose outcome came back; `created`: those that
 *  created at least one item (both only for a CREATE_PATHS type). */
interface Tally { browser: number; http: number; exempt: string | null; answered: number; created: number }

export class MixedLedger {
  readonly #tally = new Map<ActionType, Tally>();
  readonly #filler = new Map<FillerName, number>();

  /** One setup-filler call (ruling 47). Counted beside the organiser actions,
   *  never among them: coverage and the browser policy do not read it. A name
   *  outside FILLER — an organiser action type included — is refused by name
   *  (strip-types runs untyped callers). */
  filler(name: FillerName): void {
    if (!FILLERS.has(name)) throw new Error(`mixed: '${String(name)}' is not setup filler (declared: ${FILLER.join(", ")})`);
    this.#filler.set(name, (this.#filler.get(name) ?? 0) + 1);
  }

  /** The filler calls counted so far, by name ({} before any). */
  fillers(): Readonly<Partial<Record<FillerName, number>>> {
    return Object.freeze(Object.fromEntries(this.#filler));
  }

  #of(a: ActionType): Tally {
    let t = this.#tally.get(a);
    if (t === undefined) {
      t = { browser: 0, http: 0, exempt: null, answered: 0, created: 0 };
      this.#tally.set(a, t);
    }
    return t;
  }

  /** The path one invocation of `a` took. */
  record(a: ActionType, via: Via): void {
    assertType(a);
    if (via !== "browser" && via !== "http") throw new Error(`mixed: an action runs in the browser or http, got '${String(via)}'`);
    this.#of(a)[via]++;
  }

  /** O-1: a browser call of a CREATE_PATHS type answered, creating `n` items
   *  (0: its no-op branch). One answer per recorded browser call; a call whose
   *  page threw never answers, so it created nothing. */
  created(a: ActionType, n: number): void {
    assertType(a);
    if (CREATE_PATHS[a] === undefined) throw new Error(`mixed: ${a} has no create path to answer (create paths: ${Object.keys(CREATE_PATHS).join(", ")})`);
    if (!(Number.isInteger(n) && n >= 0)) throw new Error(`mixed: ${a} created must be a whole count, got ${n}`);
    const t = this.#of(a);
    if (t.answered >= t.browser) throw new Error(`mixed: ${a} answered with no browser call left to answer (${t.browser} browser call(s), ${t.answered} answered)`);
    t.answered++;
    if (n > 0) t.created++;
  }

  /** `a` has no organiser path in this cell, so it runs over http by
   *  necessity; `route` names the wave that owns the missing path, and
   *  "→ <wave>: <why>" is kept as the check's evidence. One owner per type: a
   *  second, different route is refused. strip-types runs untyped callers, so a
   *  value that is not a route to a programme wave is refused by name. */
  exempt(a: ActionType, route: Route): void {
    assertType(a);
    const r = route as Partial<Route> | null | undefined;
    if (typeof r !== "object" || r === null || typeof r.wave !== "string" || !WAVE_ID.test(r.wave) || typeof r.why !== "string" || r.why.trim() === "") {
      throw new Error(`mixed: an exemption for ${a} must carry a route to the wave that owns the missing path (routing.ts routeTo), got ${JSON.stringify(route)}`);
    }
    const reason = `→ ${r.wave}: ${r.why}`;
    const t = this.#of(a);
    if (t.exempt !== null && t.exempt !== reason) throw new Error(`mixed: ${a} is already exempt (${t.exempt}); a second reason (${reason}) would hide which wave owns it`);
    t.exempt = reason;
  }

  /** Whether the next invocation of `a` goes to the browser. `first`: until
   *  one invocation of the type has run in the browser — an http one (an
   *  exempt path) does not use up the browser's turn — or, for a CREATE_PATHS
   *  type, until one browser call has CREATED something (O-1). `all` widens
   *  only `score` (every fixture on the pad, D3); organiser actions keep the
   *  first-only rule. */
  wantsBrowser(a: ActionType, policy: PadPolicy): boolean {
    assertType(a);
    if (policy === "all" && a === "score") return true;
    const t = this.#tally.get(a);
    if (CREATE_PATHS[a] !== undefined) return (t?.created ?? 0) === 0;
    return (t?.browser ?? 0) === 0;
  }

  /** `mixed-driver-coverage`: every INVOKED type ran in the browser at least
   *  once, or is exempt. `checked` = invoked types; zero is vacuous (R25).
   *  Evidence: each red type, then each exemption that passed its type, then
   *  (O-1) for each CREATE_PATHS type that ran in the browser, whether its
   *  create path ran there — a note, never a pass condition. */
  coverage(): CheckResult {
    const id = "mixed-driver-coverage";
    const reds: string[] = [];
    const exempted: string[] = [];
    const notes: string[] = [];
    let checked = 0;
    for (const a of ACTION_TYPES) {
      const t = this.#tally.get(a);
      if (t === undefined || t.browser + t.http === 0) continue;
      checked++;
      const path = CREATE_PATHS[a];
      if (path !== undefined && t.browser > 0) {
        notes.push(t.created > 0
          ? `${a}: ${path} ran in the browser — ${t.created} of ${t.browser} browser call(s) created`
          : `${a}: ${path} never ran in the browser — ${t.browser} browser call(s), none created (a note, not a red)`);
      }
      if (t.browser > 0) continue;
      if (t.exempt !== null) exempted.push(`${a}: exempt — ${t.exempt}`);
      else reds.push(`${a}: invoked ${t.http}×, never in the browser`);
    }
    if (checked === 0) return { id, kind: "assertion", verdict: "fail", checked: 0, reason: "vacuous: the case invoked no organiser action (checked 0 is a failure)", evidence: [] };
    if (reds.length > 0) {
      return { id, kind: "assertion", verdict: "fail", checked, reason: `${reds.length} of ${checked} invoked action type(s) never ran in the browser`, evidence: [...reds, ...exempted, ...notes] };
    }
    return { id, kind: "assertion", verdict: "pass", checked, reason: `${checked} invoked action type(s): ${checked - exempted.length} ran in the browser, ${exempted.length} exempt`, evidence: [...exempted, ...notes] };
  }
}
