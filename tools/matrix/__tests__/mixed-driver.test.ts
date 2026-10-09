// The mixed-driver ledger (W1c Task 6, ruling 15; Review Focus 1). A browser
// run drives every organiser action TYPE it invokes through the UI at least
// once, and the rest over HTTP. The ledger is what proves that: a type the case
// invoked that never ran in the browser reds the case by name, unless an
// exemption names the wave that owns the missing organiser path.
//
// State transitions: nothing recorded (the empty case) → a type routed to the
// browser → the same type again → a type only ever routed to http → an
// exemption. Each is tested, in that order, below.
import { describe, expect, it } from "vitest";
import { ACTION_TYPES, CREATE_PATHS, FILLER, MixedLedger, type ActionType, type FillerName } from "../lib/driver/mixed.ts";
import { routeTo, type Route } from "../lib/routing.ts";

/** A route as a caller hands it to exempt (lib/routing.ts). */
const G5 = routeTo("W5", "no organiser UI for group_only");

/** O-1 (W1c Task 8 review): the types whose browser turn ends only once a
 *  browser call CREATED something. Typed here from the review, never read
 *  from mixed.ts — the declaration is pinned against it below. */
const KEEPS_TURN_UNTIL_CREATED: readonly ActionType[] = ["generate"];

describe("MixedLedger", () => {
  it("empty case first: a case that invoked no action is a vacuous coverage (checked 0 → fail)", () => {
    const c = new MixedLedger().coverage();
    expect(c).toMatchObject({ id: "mixed-driver-coverage", verdict: "fail", checked: 0 });
  });

  it("paths(): nothing before the first call, then each invoked type's browser and http counts, and a type never invoked stays absent", () => {
    const l = new MixedLedger();
    expect(l.paths()).toEqual({});
    l.record("settle", "browser");
    l.record("settle", "http");
    l.record("settle", "http");
    l.record("abandon", "http");
    expect(l.paths()).toEqual({ settle: { browser: 1, http: 2 }, abandon: { browser: 0, http: 1 } });
    expect(Object.hasOwn(l.paths(), "forfeit")).toBe(false);
    const before = l.paths();
    l.record("settle", "browser");
    expect(before.settle, "a reading is a snapshot, not a view").toEqual({ browser: 1, http: 2 });
    expect(Object.isFrozen(before)).toBe(true);
  });

  it("policy first: the first call of a type goes to the browser, every later one to http; policy all: score always browser", () => {
    const l = new MixedLedger();
    expect(l.wantsBrowser("start", "first")).toBe(true);
    l.record("start", "browser");
    expect(l.wantsBrowser("start", "first")).toBe(false);
    l.record("score", "browser");
    expect(l.wantsBrowser("score", "all")).toBe(true);
    expect(l.wantsBrowser("start", "all")).toBe(false);   // "all" widens only score (and finalize) — organiser actions stay first-only
  });

  it("policy first, swept over every declared action type: wanted until one browser run (for a create-path type, one that CREATED), never after — an http run does not use up the browser's turn", () => {
    let checked = 0;
    let createPath = 0;
    for (const a of ACTION_TYPES) {
      const l = new MixedLedger();
      expect(l.wantsBrowser(a, "first"), a).toBe(true);
      // A type that only ran over http (an exempt path) still owes its browser run.
      l.record(a, "http");
      expect(l.wantsBrowser(a, "first"), `${a} after http`).toBe(true);
      l.record(a, "browser");
      if (KEEPS_TURN_UNTIL_CREATED.includes(a)) {
        // O-1: a browser run that has not answered, or answered a no-op, keeps the turn.
        expect(l.wantsBrowser(a, "first"), `${a} after a browser run with no answer yet`).toBe(true);
        l.created(a, 0);
        expect(l.wantsBrowser(a, "first"), `${a} after a no-op browser run`).toBe(true);
        l.record(a, "browser");
        l.created(a, 2);
        createPath++;
      }
      expect(l.wantsBrowser(a, "first"), `${a} after browser`).toBe(false);
      // "all" keeps only score in the browser.
      expect(l.wantsBrowser(a, "all"), `${a} under all`).toBe(a === "score");
      checked++;
    }
    expect(checked).toBe(ACTION_TYPES.length);
    expect(checked).toBe(14); // the plan's twelve plus W2a's settle and abandon (a literal: the sweep cannot shrink silently)
    expect(createPath).toBe(KEEPS_TURN_UNTIL_CREATED.length);
  });

  // O-1 (W1c Task 8 review, fix round 1): generate's first call follows Start,
  // which for a league has already seeded every fixture — a no-op. First-only
  // sent only that call to the browser, so stage-rail.ts generateUi's
  // create-fixtures branch never ran live (AGENTS class 1).
  it("O-1: the create-path types are the review's, as mixed.ts declares them", () => {
    expect(Object.keys(CREATE_PATHS)).toEqual([...KEEPS_TURN_UNTIL_CREATED]);
  });

  it("O-1: generate keeps the browser's turn until a browser call CREATED fixtures — a no-op first call leaves the next in the browser; after a creating call, http under first and all", () => {
    const l = new MixedLedger();
    expect(l.wantsBrowser("generate", "first")).toBe(true);
    l.record("generate", "browser");
    l.created("generate", 0); // the no-op right after Start
    expect(l.wantsBrowser("generate", "first")).toBe(true);
    expect(l.wantsBrowser("generate", "all")).toBe(true);
    l.record("generate", "browser");
    l.created("generate", 4);
    expect(l.wantsBrowser("generate", "first")).toBe(false);
    expect(l.wantsBrowser("generate", "all")).toBe(false);
    // The second call: an http no-op after the creating one does not reopen the turn.
    l.record("generate", "http");
    expect(l.wantsBrowser("generate", "first")).toBe(false);
  });

  it("O-1: a browser call that never answered (the page threw) created nothing — the next still goes to the browser", () => {
    const l = new MixedLedger();
    l.record("generate", "browser");
    expect(l.wantsBrowser("generate", "first")).toBe(true);
  });

  it("O-1: coverage NOTES whether the create path ran in the browser — a note after the reds and exemptions, never a pass condition", () => {
    const noop = new MixedLedger();
    for (let i = 0; i < 2; i++) { noop.record("generate", "browser"); noop.created("generate", 0); }
    expect(noop.coverage()).toMatchObject({ verdict: "pass", checked: 1, evidence: [`generate: ${CREATE_PATHS.generate} never ran in the browser — 2 browser call(s), none created (a note, not a red)`] });
    const ran = new MixedLedger();
    ran.record("generate", "browser");
    ran.created("generate", 0);
    ran.record("generate", "browser");
    ran.created("generate", 3);
    ran.record("generate", "http");
    expect(ran.coverage()).toMatchObject({ verdict: "pass", checked: 1, evidence: [`generate: ${CREATE_PATHS.generate} ran in the browser — 1 of 2 browser call(s) created`] });
    // Beside a red and an exemption, the note comes last.
    ran.record("withdraw", "http");
    ran.record("createDivision", "http");
    ran.exempt("createDivision", G5);
    expect(ran.coverage()).toMatchObject({ verdict: "fail", checked: 3, evidence: [
      "withdraw: invoked 1×, never in the browser",
      "createDivision: exempt — → W5: no organiser UI for group_only",
      `generate: ${CREATE_PATHS.generate} ran in the browser — 1 of 2 browser call(s) created`,
    ] });
    // generate only ever over http: the red says so, and there is no browser call to note.
    const httpOnly = new MixedLedger();
    httpOnly.record("generate", "http");
    expect(httpOnly.coverage().evidence).toEqual(["generate: invoked 1×, never in the browser"]);
  });

  it("O-1: an answer is refused by name for a type with no create path, a count that is not whole, or no browser call left to answer", () => {
    const l = new MixedLedger();
    expect(() => l.created("start", 1)).toThrow(/no create path/);
    expect(() => l.created("generate", 1)).toThrow(/no browser call/);
    l.record("generate", "browser");
    expect(() => l.created("generate", -1)).toThrow(/whole/);
    expect(() => l.created("generate", 1.5)).toThrow(/whole/);
    l.created("generate", 0);
    // One answer per browser call: a second has nothing to answer.
    expect(() => l.created("generate", 0)).toThrow(/no browser call/);
    expect(() => l.created("finalise" as ActionType, 1)).toThrow(/not an action type/);
  });

  it("a missing browser action reds by name (Review Focus 1)", () => {
    const l = new MixedLedger();
    l.record("createCompetition", "browser");
    l.record("generate", "http");
    const c = l.coverage();
    expect(c.verdict).toBe("fail");
    expect(c.checked).toBe(2);
    expect(c.evidence).toEqual(["generate: invoked 1×, never in the browser"]);
  });

  it("a type that ran in the browser once and over http after passes, with its invocations counted", () => {
    const l = new MixedLedger();
    l.record("start", "browser");
    l.record("start", "http");
    l.record("start", "http");
    expect(l.coverage()).toMatchObject({ id: "mixed-driver-coverage", kind: "assertion", verdict: "pass", checked: 1, evidence: [] });
    // The http-only one beside it still reds, counting every invocation.
    l.record("withdraw", "http");
    l.record("withdraw", "http");
    expect(l.coverage()).toMatchObject({ verdict: "fail", checked: 2, evidence: ["withdraw: invoked 2×, never in the browser"] });
  });

  it("an exemption passes its type only with a route to the owning wave, and the route is kept as evidence (→ wave: why)", () => {
    const l = new MixedLedger();
    l.record("createDivision", "http");
    // strip-types runs untyped callers: the old reason string is refused by name, never stored as "→ undefined".
    expect(() => l.exempt("createDivision", "no organiser UI → W4" as unknown as Route)).toThrow(/must carry a route/);
    l.exempt("createDivision", routeTo("W4", "no organiser UI for page_playoff_only"));
    expect(l.coverage()).toMatchObject({ verdict: "pass", checked: 1, evidence: ["createDivision: exempt — → W4: no organiser UI for page_playoff_only"] });
  });

  it("the W1-driving wave is a wave; a hand-built route to a non-wave, or with no why, is not", () => {
    const l = new MixedLedger();
    const bad = [{ wave: "W", why: "x" }, { wave: "wave 4", why: "x" }, { wave: "W11", why: "x" }, { wave: "", why: "x" }, { wave: "W4", why: " " }, { wave: "W4" }, null];
    let refused = 0;
    for (const b of bad) { expect(() => l.exempt("createDivision", b as unknown as Route), JSON.stringify(b)).toThrow(/must carry a route/); refused++; }
    expect(refused).toBe(bad.length);
    l.exempt("createDivision", routeTo("W1-driving", "reachable only through catalog template box-league; driving it"));
    l.record("createDivision", "http");
    expect(l.coverage()).toMatchObject({ verdict: "pass", checked: 1, evidence: ["createDivision: exempt — → W1-driving: reachable only through catalog template box-league; driving it"] });
  });

  it("an exempt type still counts its failures beside another type's red, exemption evidence after the reds", () => {
    const l = new MixedLedger();
    l.record("createDivision", "http");
    l.exempt("createDivision", G5);
    l.record("score", "http");
    expect(l.coverage()).toMatchObject({
      verdict: "fail", checked: 2,
      evidence: ["score: invoked 1×, never in the browser", "createDivision: exempt — → W5: no organiser UI for group_only"],
    });
  });

  it("an exemption for a type the case never invoked checks nothing (still vacuous alone)", () => {
    const l = new MixedLedger();
    l.exempt("createDivision", G5);
    expect(l.coverage()).toMatchObject({ verdict: "fail", checked: 0 });
  });

  it("a second exemption for a type must say the same thing: one owner per missing path", () => {
    const l = new MixedLedger();
    l.exempt("createDivision", G5);
    l.exempt("createDivision", G5);
    // The same text again (a second route object) is the same owner.
    l.exempt("createDivision", routeTo("W5", "no organiser UI for group_only"));
    expect(() => l.exempt("createDivision", routeTo("W4", "no organiser UI for group_only"))).toThrow(/already exempt/);
    expect(() => l.exempt("createDivision", routeTo("W5", "another reason"))).toThrow(/already exempt/);
  });

  it("an action type the ledger does not declare is refused by name (strip-types runs untyped callers)", () => {
    const l = new MixedLedger();
    expect(() => l.record("finalise" as ActionType, "browser")).toThrow(/not an action type/);
    expect(() => l.wantsBrowser("finalise" as ActionType, "first")).toThrow(/not an action type/);
    expect(() => l.exempt("finalise" as ActionType, routeTo("W4", "x"))).toThrow(/not an action type/);
    expect(() => l.record("generate", "carrier-pigeon" as "http")).toThrow(/browser or http/);
  });

  it("ACTION_TYPES is the plan's list, in its order - W2a (Task 14 Step 8) adds the organiser's other two organiser-only acts, settle and abandon, beside forfeit (X-ST-2)", () => {
    expect([...ACTION_TYPES]).toEqual(["createCompetition", "createDivision", "addEntrants", "start", "generate", "score", "voidLast", "forfeit", "settle", "abandon", "withdraw", "completeStage", "standingsView", "publicView"]);
  });
});

// Ruling 47 (W1-driving Task 3): setup filler is HTTP by design in every
// layer. The ledger counts it so a report can show it ran, and it is never an
// organiser action type, so no browser turn is owed and coverage is untouched.
// Transitions: no filler (the empty case) → a filler call → the same again →
// a name outside FILLER.
describe("MixedLedger — setup filler (ruling 47)", () => {
  it("empty case first: a fresh ledger has counted no filler", () => {
    expect(new MixedLedger().fillers()).toEqual({});
  });

  it("FILLER is the plan's list, in its order, and shares no name with an organiser action type", () => {
    expect([...FILLER]).toEqual(["setMembers", "putLineup", "entrantMembers", "confirmSeedProposal", "recomputeSeedProposal", "challenge", "americanoView", "scheduleFixtureNow"]);
    expect(FILLER.filter((f) => (ACTION_TYPES as readonly string[]).includes(f))).toEqual([]);
  });

  it("filler counts each call by name, a second call adding to the first", () => {
    const l = new MixedLedger();
    l.filler("setMembers");
    l.filler("setMembers");
    l.filler("putLineup");
    expect(l.fillers()).toEqual({ setMembers: 2, putLineup: 1 });
  });

  it("a name outside FILLER is refused by name — an organiser action type too (strip-types runs untyped callers)", () => {
    const l = new MixedLedger();
    for (const bad of ["postEvent", "addEntrants", "score", ""]) expect(() => l.filler(bad as FillerName), bad).toThrow(/not setup filler/);
    expect(l.fillers()).toEqual({});
  });

  it("filler leaves coverage and the browser policy exactly as they were — it is never an organiser action", () => {
    const with_ = new MixedLedger();
    const without = new MixedLedger();
    for (const l of [with_, without]) {
      l.record("createCompetition", "browser");
      l.record("addEntrants", "browser");
      l.record("addEntrants", "http");
    }
    for (const f of FILLER) with_.filler(f);
    expect(with_.fillers()).toEqual(Object.fromEntries(FILLER.map((f) => [f, 1])));
    expect(with_.coverage()).toEqual(without.coverage());
    for (const a of ACTION_TYPES) expect(with_.wantsBrowser(a, "first"), a).toBe(without.wantsBrowser(a, "first"));
    // And on a ledger with filler only, coverage is still the vacuous empty case.
    const only = new MixedLedger();
    only.filler("putLineup");
    expect(only.coverage()).toMatchObject({ verdict: "fail", checked: 0 });
  });
});
