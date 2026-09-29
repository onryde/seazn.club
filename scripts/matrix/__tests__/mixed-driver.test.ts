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
import { ACTION_TYPES, MixedLedger, type ActionType } from "../lib/driver/mixed.ts";

describe("MixedLedger", () => {
  it("empty case first: a case that invoked no action is a vacuous coverage (checked 0 → fail)", () => {
    const c = new MixedLedger().coverage();
    expect(c).toMatchObject({ id: "mixed-driver-coverage", verdict: "fail", checked: 0 });
  });

  it("policy first: the first call of a type goes to the browser, every later one to http; policy all: score always browser", () => {
    const l = new MixedLedger();
    expect(l.wantsBrowser("generate", "first")).toBe(true);
    l.record("generate", "browser");
    expect(l.wantsBrowser("generate", "first")).toBe(false);
    l.record("score", "browser");
    expect(l.wantsBrowser("score", "all")).toBe(true);
    expect(l.wantsBrowser("generate", "all")).toBe(false);   // "all" widens only score (and finalize) — organiser actions stay first-only
  });

  it("policy first, swept over every declared action type: wanted until one browser run, never after — an http run does not use up the browser's turn", () => {
    let checked = 0;
    for (const a of ACTION_TYPES) {
      const l = new MixedLedger();
      expect(l.wantsBrowser(a, "first"), a).toBe(true);
      // A type that only ran over http (an exempt path) still owes its browser run.
      l.record(a, "http");
      expect(l.wantsBrowser(a, "first"), `${a} after http`).toBe(true);
      l.record(a, "browser");
      expect(l.wantsBrowser(a, "first"), `${a} after browser`).toBe(false);
      // "all" keeps only score in the browser.
      expect(l.wantsBrowser(a, "all"), `${a} under all`).toBe(a === "score");
      checked++;
    }
    expect(checked).toBe(ACTION_TYPES.length);
    expect(checked).toBe(11);
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
    l.record("generate", "browser");
    l.record("generate", "http");
    l.record("generate", "http");
    expect(l.coverage()).toMatchObject({ id: "mixed-driver-coverage", kind: "assertion", verdict: "pass", checked: 1, evidence: [] });
    // The http-only one beside it still reds, counting every invocation.
    l.record("withdraw", "http");
    l.record("withdraw", "http");
    expect(l.coverage()).toMatchObject({ verdict: "fail", checked: 2, evidence: ["withdraw: invoked 2×, never in the browser"] });
  });

  it("an exemption passes its type only with a reason naming a wave, and the reason is kept as evidence", () => {
    const l = new MixedLedger();
    l.record("createDivision", "http");
    expect(() => l.exempt("createDivision", "no organiser UI")).toThrow(/wave/);
    l.exempt("createDivision", "no organiser UI for page_playoff_only → W4");
    expect(l.coverage()).toMatchObject({ verdict: "pass", checked: 1, evidence: ["createDivision: exempt — no organiser UI for page_playoff_only → W4"] });
  });

  it("the W1-driving wave is a wave; a bare arrow or a W with no number is not", () => {
    const l = new MixedLedger();
    for (const bad of ["→ W", "→ wave 4", "W4", "→W4"]) expect(() => l.exempt("createDivision", bad), bad).toThrow(/wave/);
    l.exempt("createDivision", "reachable only through catalog template box-league; driving it → W1-driving");
    l.record("createDivision", "http");
    expect(l.coverage()).toMatchObject({ verdict: "pass", checked: 1 });
  });

  it("an exempt type still counts its failures beside another type's red, exemption evidence after the reds", () => {
    const l = new MixedLedger();
    l.record("createDivision", "http");
    l.exempt("createDivision", "no organiser UI for group_only → W5");
    l.record("score", "http");
    expect(l.coverage()).toMatchObject({
      verdict: "fail", checked: 2,
      evidence: ["score: invoked 1×, never in the browser", "createDivision: exempt — no organiser UI for group_only → W5"],
    });
  });

  it("an exemption for a type the case never invoked checks nothing (still vacuous alone)", () => {
    const l = new MixedLedger();
    l.exempt("createDivision", "no organiser UI for group_only → W5");
    expect(l.coverage()).toMatchObject({ verdict: "fail", checked: 0 });
  });

  it("a second exemption for a type must say the same thing: one owner per missing path", () => {
    const l = new MixedLedger();
    l.exempt("createDivision", "no organiser UI for group_only → W5");
    l.exempt("createDivision", "no organiser UI for group_only → W5");
    expect(() => l.exempt("createDivision", "no organiser UI for group_only → W4")).toThrow(/already exempt/);
  });

  it("an action type the ledger does not declare is refused by name (strip-types runs untyped callers)", () => {
    const l = new MixedLedger();
    expect(() => l.record("finalise" as ActionType, "browser")).toThrow(/not an action type/);
    expect(() => l.wantsBrowser("finalise" as ActionType, "first")).toThrow(/not an action type/);
    expect(() => l.exempt("finalise" as ActionType, "x → W4")).toThrow(/not an action type/);
    expect(() => l.record("generate", "carrier-pigeon" as "http")).toThrow(/browser or http/);
  });

  it("ACTION_TYPES is the plan's list, in its order", () => {
    expect([...ACTION_TYPES]).toEqual(["createCompetition", "createDivision", "addEntrants", "start", "generate", "score", "forfeit", "withdraw", "completeStage", "standingsView", "publicView"]);
  });
});
