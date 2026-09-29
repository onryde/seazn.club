// The mixed-driver ledger (W1c Task 6; ruling 15, design §6.2). A browser run
// drives every distinct organiser action TYPE it invokes through the UI at
// least once and the remaining calls of that type over HTTP. This ledger is
// the proof it did (Review Focus 1): a type the case invoked that never ran in
// the browser reds the case on `mixed-driver-coverage`, by name — a page
// object that quietly fell back to HTTP can never read as a browser green.
// The one way past that is an exemption, whose reason must name the wave that
// owns the missing organiser path (D7: the API-only rows).
//
// Pure: no browser, no HTTP. BrowserDriver asks `wantsBrowser` before each
// organiser action, `record`s the path it took, and returns `coverage()` among
// its checks.
import type { CheckResult } from "../results.ts";

export const ACTION_TYPES = ["createCompetition", "createDivision", "addEntrants", "start", "generate", "score", "forfeit", "withdraw", "completeStage", "standingsView", "publicView"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export type Via = "browser" | "http";
export type PadPolicy = "first" | "all";

/** An exemption's reason names the wave that owns the missing path: "→ W<n>"
 *  (design §8) or "→ W1-driving" (ruling 28). */
const NAMES_A_WAVE = /→ W\d|→ W1-driving/;

const DECLARED: ReadonlySet<string> = new Set(ACTION_TYPES);

function assertType(a: string): asserts a is ActionType {
  if (!DECLARED.has(a)) throw new Error(`mixed: '${a}' is not an action type (declared: ${ACTION_TYPES.join(", ")})`);
}

interface Tally { browser: number; http: number; exempt: string | null }

export class MixedLedger {
  readonly #tally = new Map<ActionType, Tally>();

  #of(a: ActionType): Tally {
    let t = this.#tally.get(a);
    if (t === undefined) {
      t = { browser: 0, http: 0, exempt: null };
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

  /** `a` has no organiser path in this cell, so it runs over http by
   *  necessity; `reason` names the wave that owns the missing path, and is kept
   *  as the check's evidence. One owner per type: a second, different reason is
   *  refused. */
  exempt(a: ActionType, reason: string): void {
    assertType(a);
    if (!NAMES_A_WAVE.test(reason)) {
      throw new Error(`mixed: an exemption for ${a} must name the wave that owns the missing path ("→ W<n>" or "→ W1-driving"), got ${JSON.stringify(reason)}`);
    }
    const t = this.#of(a);
    if (t.exempt !== null && t.exempt !== reason) throw new Error(`mixed: ${a} is already exempt (${t.exempt}); a second reason (${reason}) would hide which wave owns it`);
    t.exempt = reason;
  }

  /** Whether the next invocation of `a` goes to the browser. `first`: until
   *  one invocation of the type has run in the browser — an http one (an
   *  exempt path) does not use up the browser's turn. `all` widens only
   *  `score` (every fixture on the pad, D3); organiser actions stay first-only. */
  wantsBrowser(a: ActionType, policy: PadPolicy): boolean {
    assertType(a);
    if (policy === "all" && a === "score") return true;
    return (this.#tally.get(a)?.browser ?? 0) === 0;
  }

  /** `mixed-driver-coverage`: every INVOKED type ran in the browser at least
   *  once, or is exempt. `checked` = invoked types; zero is vacuous (R25).
   *  Evidence: each red type, then each exemption that passed its type. */
  coverage(): CheckResult {
    const id = "mixed-driver-coverage";
    const reds: string[] = [];
    const exempted: string[] = [];
    let checked = 0;
    for (const a of ACTION_TYPES) {
      const t = this.#tally.get(a);
      if (t === undefined || t.browser + t.http === 0) continue;
      checked++;
      if (t.browser > 0) continue;
      if (t.exempt !== null) exempted.push(`${a}: exempt — ${t.exempt}`);
      else reds.push(`${a}: invoked ${t.http}×, never in the browser`);
    }
    if (checked === 0) return { id, kind: "assertion", verdict: "fail", checked: 0, reason: "vacuous: the case invoked no organiser action (checked 0 is a failure)", evidence: [] };
    if (reds.length > 0) {
      return { id, kind: "assertion", verdict: "fail", checked, reason: `${reds.length} of ${checked} invoked action type(s) never ran in the browser`, evidence: [...reds, ...exempted] };
    }
    return { id, kind: "assertion", verdict: "pass", checked, reason: `${checked} invoked action type(s): ${checked - exempted.length} ran in the browser, ${exempted.length} exempt`, evidence: exempted };
  }
}
