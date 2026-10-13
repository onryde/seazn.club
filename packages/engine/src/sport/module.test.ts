// S6/#416 (W5) — the two pure helpers PadSpec's gate DSL and action payload
// assembly are built on: `evalPadGate` (shared by this engine's own
// conformance property test and, from S10, the browser renderer — so the two
// sides can never compute "should this panel show" differently) and
// `buildPathObject` (the inverse of `resolvePayloadPath`, shared the same
// way for turning collected field values into a real event payload).
//
// R8/WS-B — `isPathRequired`/`stampAttributionRequired`: the shared
// schema->required derivation (memory rule #19, owner decision #1 — never
// hand-type a per-sport `required` literal). Closes the live dead-end-tap
// bug: a pad let a scorer confirm an action with a REQUIRED attribution item
// unfilled, and the engine's `z.strictObject` silently rejected the payload.
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  buildPathObject,
  evalPadGate,
  isPathRequired,
  stampAttributionRequired,
  type PadGate,
  type PadSpec,
} from "./module.ts";

describe("evalPadGate", () => {
  const ctx = { state: { phase: "super_over", cfg: { dls: { enabled: true } } }, summary: { headline: "H — A" } };

  it("always is always true", () => {
    expect(evalPadGate({ op: "always" }, ctx)).toBe(true);
  });

  it("path-truthy reads a nested path under state", () => {
    expect(evalPadGate({ op: "path-truthy", path: "state.cfg.dls.enabled" }, ctx)).toBe(true);
    expect(evalPadGate({ op: "path-truthy", path: "state.cfg.dls.disabled" }, ctx)).toBe(false);
  });

  it("path-truthy reads under summary too", () => {
    expect(evalPadGate({ op: "path-truthy", path: "summary.headline" }, ctx)).toBe(true);
  });

  it("path-truthy on a missing path is false, never throws", () => {
    expect(evalPadGate({ op: "path-truthy", path: "state.does.not.exist" }, ctx)).toBe(false);
  });

  it("path-equals compares the resolved value by ===", () => {
    expect(evalPadGate({ op: "path-equals", path: "state.phase", value: "super_over" }, ctx)).toBe(true);
    expect(evalPadGate({ op: "path-equals", path: "state.phase", value: "live" }, ctx)).toBe(false);
  });

  it("path-equals against a missing path only matches value: null semantics via undefined !== null", () => {
    // resolvePayloadPath returns `undefined` for a miss; `undefined === null` is
    // false, so a gate cannot be accidentally satisfied by a typo'd path.
    expect(evalPadGate({ op: "path-equals", path: "state.nope", value: null }, ctx)).toBe(false);
  });

  it("and is true when every sub-gate is true", () => {
    const gate: PadGate = {
      op: "and",
      of: [
        { op: "path-equals", path: "state.phase", value: "super_over" },
        { op: "path-truthy", path: "state.cfg.dls.enabled" },
      ],
    };
    expect(evalPadGate(gate, ctx)).toBe(true);
  });

  it("and is false when one sub-gate fails", () => {
    const gate: PadGate = {
      op: "and",
      of: [
        { op: "path-equals", path: "state.phase", value: "super_over" },
        { op: "path-equals", path: "state.phase", value: "live" },
      ],
    };
    expect(evalPadGate(gate, ctx)).toBe(false);
  });

  it("or requires at least one sub-gate", () => {
    const gate: PadGate = {
      op: "or",
      of: [
        { op: "path-equals", path: "state.phase", value: "live" },
        { op: "path-equals", path: "state.phase", value: "super_over" },
      ],
    };
    expect(evalPadGate(gate, ctx)).toBe(true);
  });

  it("or is false when every sub-gate fails", () => {
    const gate: PadGate = {
      op: "or",
      of: [
        { op: "path-equals", path: "state.phase", value: "live" },
        { op: "path-equals", path: "state.phase", value: "done" },
      ],
    };
    expect(evalPadGate(gate, ctx)).toBe(false);
  });

  it("not inverts its sub-gate", () => {
    expect(evalPadGate({ op: "not", of: { op: "always" } }, ctx)).toBe(false);
    expect(
      evalPadGate({ op: "not", of: { op: "path-equals", path: "state.phase", value: "live" } }, ctx),
    ).toBe(true);
  });

  it("nests and/or/not arbitrarily deep", () => {
    const gate: PadGate = {
      op: "and",
      of: [
        { op: "not", of: { op: "path-equals", path: "state.phase", value: "live" } },
        { op: "or", of: [{ op: "always" }, { op: "path-truthy", path: "nope" }] },
      ],
    };
    expect(evalPadGate(gate, ctx)).toBe(true);
  });
});

describe("buildPathObject", () => {
  it("assembles a flat object from single-segment paths", () => {
    expect(buildPathObject([["runs", 4]])).toEqual({ runs: 4 });
  });

  it("nests dotted paths into a plain object tree", () => {
    expect(
      buildPathObject([
        ["runs.bat", 0],
        ["runs.extras.kind", "wide"],
        ["runs.extras.runs", 1],
      ]),
    ).toEqual({ runs: { bat: 0, extras: { kind: "wide", runs: 1 } } });
  });

  it("omits undefined values instead of writing the key", () => {
    const built = buildPathObject([
      ["wicket.out", "p1"],
      ["wicket.fielder", undefined],
    ]);
    expect(built).toEqual({ wicket: { out: "p1" } });
    expect(Object.hasOwn(built.wicket as object, "fielder")).toBe(false);
  });

  it("keeps falsy-but-defined values (0, false, empty string)", () => {
    expect(buildPathObject([["runs.bat", 0]])).toEqual({ runs: { bat: 0 } });
    expect(buildPathObject([["freeHit", false]])).toEqual({ freeHit: false });
  });

  it("shares an intermediate object across two entries at the same prefix", () => {
    // Order independence: whichever entry creates "wicket" first, the second
    // must land on the SAME object rather than clobbering it.
    const a = buildPathObject([
      ["wicket.kind", "bowled"],
      ["wicket.out", "p1"],
    ]);
    const b = buildPathObject([
      ["wicket.out", "p1"],
      ["wicket.kind", "bowled"],
    ]);
    expect(a).toEqual(b);
    expect(a).toEqual({ wicket: { kind: "bowled", out: "p1" } });
  });

  it("round-trips through JSON unchanged (pure data, no surprises)", () => {
    const built = buildPathObject([
      ["over", 3],
      ["wicket.kind", "caught"],
      ["wicket.bowlerCredited", true],
    ]);
    expect(JSON.parse(JSON.stringify(built))).toEqual(built);
  });

  it("an empty entry list builds an empty object", () => {
    expect(buildPathObject([])).toEqual({});
  });
});

describe("isPathRequired", () => {
  const Wicket = z.strictObject({
    out: z.string().min(1),
    fielder: z.string().min(1).optional(),
  });
  const Ball = z.strictObject({
    striker: z.string().min(1),
    wicket: Wicket.optional(),
  });

  it("a plain top-level required field is required", () => {
    expect(isPathRequired(Ball, "striker")).toBe(true);
  });

  it("a plain top-level optional field is not required", () => {
    expect(isPathRequired(Ball, "wicket")).toBe(false);
  });

  it("walks into a nested object to find a required leaf, even though the parent object is itself optional", () => {
    // `wicket` is `.optional()` on Ball (only some actions populate it), but
    // `wicket.out` is non-optional WITHIN CricketWicket — an action that
    // does build `wicket` must always fill `out`. This is the exact cricket
    // shape (BALL/WICKET_ATTRIBUTION over CricketBall/CricketWicket).
    expect(isPathRequired(Ball, "wicket.out")).toBe(true);
  });

  it("a nested optional leaf is not required", () => {
    expect(isPathRequired(Ball, "wicket.fielder")).toBe(false);
  });

  it("throws on a path that does not resolve against the schema — a typo must never silently read as optional", () => {
    expect(() => isPathRequired(Ball, "wicket.doesNotExist")).toThrow();
    expect(() => isPathRequired(Ball, "doesNotExist")).toThrow();
  });

  // R8 branch review, finding 7 — three DIFFERENT faults used to share one
  // message. `objectShapeOf` returns `undefined` both when a segment is not
  // (and does not wrap) an object AND when its 8-hop wrapper bound is
  // exhausted, and `isPathRequired` reported every one of them as
  // `no field "<segment>" found` — a diagnosis that sends the reader hunting
  // for a typo in a path that is perfectly correct. Each fault now names
  // itself. Asserted on the MESSAGE, not merely that it throws: the old code
  // threw too, so a bare `.toThrow()` cannot witness this regression.
  function messageFrom(fn: () => unknown): string {
    try {
      fn();
    } catch (err) {
      return (err as Error).message;
    }
    throw new Error("expected isPathRequired to throw, but it returned");
  }

  it("a genuinely missing key still reports the missing FIELD", () => {
    const message = messageFrom(() => isPathRequired(Ball, "wicket.doesNotExist"));
    expect(message).toMatch(/no field "doesNotExist" found/);
    expect(message).not.toMatch(/wrapper/i);
  });

  it("an OVER-WRAPPED schema reports the wrapper-depth bound, never a bogus missing field", () => {
    // 9 modifier hops to reach the object — one past `objectShapeOf`'s bound.
    // `a` is really there; the walk simply gives up before it can see it, so
    // "no field a found" would be a false statement about the schema.
    let overWrapped: z.ZodTypeAny = z.strictObject({ a: z.string() });
    for (let i = 0; i < 9; i++) overWrapped = overWrapped.optional();
    const outer = z.strictObject({ inner: overWrapped });
    const message = messageFrom(() => isPathRequired(outer, "inner.a"));
    expect(message).toMatch(/wrapper/i);
    expect(message).not.toMatch(/no field "a" found/);
    // Each part of the diagnosis is read by whoever hits it: where the walk stopped, that it is a depth bound and not a
    // missing key, and what to do about it.
    expect(message).toMatch(/"inner" still wraps something after \d+ modifier hops, so the walk gave up before it could look for "a"/);
    expect(message).toMatch(/\(this is a WRAPPER-DEPTH bound, not a missing field — "a" may well exist; /);
    expect(message).toMatch(/unwrap the schema or raise MAX_WRAPPER_HOPS in sport\/module\.ts\)$/);
  });

  it("a segment that is not an object at all says so, rather than blaming the next segment", () => {
    // `striker` is a z.string(); "foo" beneath it is unresolvable because
    // striker is a leaf, not because the schema is missing a `foo` key.
    const message = messageFrom(() => isPathRequired(Ball, "striker.foo"));
    expect(message).toMatch(/striker/);
    expect(message).not.toMatch(/no field "foo" found/);
    expect(message).toMatch(/"striker" is not an object schema and does not wrap one, so nothing can be resolved beneath it/);
    expect(message).toMatch(/\(a PadAttributionItem\/PadField path must not walk past a leaf value\)$/);
  });

  it("a nullable-but-not-optional field is still required (nullable != optional)", () => {
    const schema = z.strictObject({ maybe: z.string().nullable() });
    expect(isPathRequired(schema, "maybe")).toBe(true);
  });

  it("unwraps a schema-level .refine() on the way to a nested shape (zod v4 keeps .shape after .refine on an object)", () => {
    const refined = z.strictObject({ a: z.string() }).refine(() => true);
    const outer = z.strictObject({ inner: refined });
    expect(isPathRequired(outer, "inner.a")).toBe(true);
  });
});

// W2c BG-KO-2 — `boardgame.tiebreak` is one event type with two payload shapes (rapid/blitz name the winner, an
// Armageddon names Black and the result), registered as a discriminated union. `isPathRequired` therefore has to
// resolve a path THROUGH the union's branches or the pad's Confirm gate (`required`) cannot be derived for it.
describe("isPathRequired through a union", () => {
  const Timed = z.strictObject({ rung: z.enum(["rapid", "blitz"]), winner: z.string().min(1), note: z.string().optional() });
  const Armageddon = z.strictObject({ rung: z.literal("armageddon"), black: z.string().min(1), note: z.string() });
  const Tiebreak = z.discriminatedUnion("rung", [Timed, Armageddon]);

  it("a key only one branch declares takes that branch's requiredness — each branch's own key, both ways", () => {
    expect(isPathRequired(Tiebreak, "winner")).toBe(true);
    expect(isPathRequired(Tiebreak, "black")).toBe(true);
    const lenient = z.discriminatedUnion("rung", [
      z.strictObject({ rung: z.literal("a"), x: z.string().optional() }),
      z.strictObject({ rung: z.literal("b"), y: z.string() }),
    ]);
    expect(isPathRequired(lenient, "x")).toBe(false); // the positive pair: an optional key stays optional through the union
    expect(isPathRequired(lenient, "y")).toBe(true);
  });

  it("a key several branches declare is required only when EVERY declaring branch requires it", () => {
    expect(isPathRequired(Tiebreak, "rung")).toBe(true);
    expect(isPathRequired(Tiebreak, "note")).toBe(false); // optional in one branch, required in the other
    const both = z.discriminatedUnion("k", [
      z.strictObject({ k: z.literal("a"), v: z.string() }),
      z.strictObject({ k: z.literal("b"), v: z.string() }),
    ]);
    expect(isPathRequired(both, "v")).toBe(true);
  });

  it("resolves through a union nested under an object field, and through a plain z.union", () => {
    expect(isPathRequired(z.strictObject({ t: Tiebreak }), "t.black")).toBe(true);
    expect(isPathRequired(z.union([z.strictObject({ a: z.string() }), z.strictObject({ b: z.string().optional() })]), "b")).toBe(false);
    expect(isPathRequired(z.union([z.strictObject({ a: z.string() }), z.strictObject({ b: z.string().optional() })]), "a")).toBe(true);
  });

  it("a key no branch declares still throws, naming the missing field (a typo never reads as optional)", () => {
    expect(() => isPathRequired(Tiebreak, "doesNotExist")).toThrow(/no field "doesNotExist" found/);
    expect(() => isPathRequired(z.strictObject({ t: Tiebreak }), "t.doesNotExist")).toThrow(/no field "doesNotExist" found/);
  });

  it("an enum is still a leaf — its `.options` are strings, not branches, and nothing resolves beneath it", () => {
    const withEnum = z.strictObject({ kind: z.enum(["a", "b"]) });
    expect(() => isPathRequired(withEnum, "kind.a")).toThrow(/not an object schema/);
    expect(() => isPathRequired(withEnum, "kind.a")).toThrow(/must not walk past a leaf value\)$/);
  });
});

describe("stampAttributionRequired", () => {
  const EVENT_SCHEMAS = {
    "x.toss": z.strictObject({ wonBy: z.string().min(1) }),
    "x.review": z.strictObject({ by: z.string().min(1), person: z.string().min(1).optional() }),
  };

  const baseSpec: PadSpec = {
    panels: [
      {
        labelKey: { key: "pad.x.panel.pre", label: "Pre" },
        phase: "pre",
        layout: "primary",
        actions: [
          {
            type: "x.toss",
            labelKey: { key: "pad.x.action.toss", label: "Toss" },
            fields: [],
            attribution: [{ kind: "side", path: "wonBy" }],
          },
          {
            type: "x.review",
            labelKey: { key: "pad.x.action.review", label: "Review" },
            fields: [],
            attribution: [
              { kind: "side", path: "by" },
              { kind: "person", path: "person" },
            ],
          },
        ],
      },
    ],
    fidelity: { "x.toss": 0, "x.review": 0 },
  };

  it("stamps required:true on a schema-required attribution item and required:false on an optional one", () => {
    const stamped = stampAttributionRequired(baseSpec, EVENT_SCHEMAS);
    const review = stamped.panels[0]!.actions.find((a) => a.type === "x.review")!;
    expect(review.attribution).toEqual([
      { kind: "side", path: "by", required: true },
      { kind: "person", path: "person", required: false },
    ]);
  });

  it("stamps every action across every panel, never just the first", () => {
    const stamped = stampAttributionRequired(baseSpec, EVENT_SCHEMAS);
    const toss = stamped.panels[0]!.actions.find((a) => a.type === "x.toss")!;
    expect(toss.attribution).toEqual([{ kind: "side", path: "wonBy", required: true }]);
  });

  it("leaves an action's attribution untouched (no throw) when its type has no registered schema — checkActionCoverage's job to flag, not this one's", () => {
    const specWithUnknownType: PadSpec = {
      ...baseSpec,
      panels: [
        {
          ...baseSpec.panels[0]!,
          actions: [
            {
              type: "x.unregistered",
              labelKey: { key: "pad.x.action.unregistered", label: "?" },
              fields: [],
              attribution: [{ kind: "side", path: "wonBy" }],
            },
          ],
        },
      ],
    };
    const stamped = stampAttributionRequired(specWithUnknownType, EVENT_SCHEMAS);
    expect(stamped.panels[0]!.actions[0]!.attribution).toEqual([{ kind: "side", path: "wonBy" }]);
  });

  it("is pure — does not mutate the input spec", () => {
    const before = JSON.parse(JSON.stringify(baseSpec));
    stampAttributionRequired(baseSpec, EVENT_SCHEMAS);
    expect(baseSpec).toEqual(before);
  });
});
