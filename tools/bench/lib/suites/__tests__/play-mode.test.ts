// B07a T7 — a suite declares HOW each of its divisions is played, and the
// runner dispatches on that declaration instead of hard-coding one path for
// the first division and another for the rest.
//
// The DEFAULT is the whole risk here. Before this task the write path was
// positional: `plan.divisions[0]` folded through the single-event scoring
// route and every other division through the batch-import route. Two live
// exercises depend on that split staying exactly where it is — `_RULES.md` §3
// keeps one suite on the single-POST path, and the import path needs a live
// subject of its own — so a play mode that silently moved `_tiny`'s
// `d-tiny`/`d-badminton` or suite 11's `d-worlds`/`d-womens` would REMOVE
// coverage while appearing to add some.
//
// Every case below therefore pins a VALUE, never mere reachability
// (AGENTS.md rule 19): the two "declared wins" cases are deliberately chosen
// so the declared answer DISAGREES with the positional one, which is the only
// shape that can witness a helper that ignored the declaration entirely.
import { describe, expect, it } from "vitest";
import { playModeFor, type PlayMode } from "../types.ts";

/** A suite that declares nothing — every pack shipped before this task. */
const undeclared = {};

describe("playModeFor — the default reproduces the positional behaviour verbatim", () => {
  it("routes the FIRST division through the single-event route and every other one through import", () => {
    expect(playModeFor(undeclared, "d-any", 0)).toBe("api");
    expect(playModeFor(undeclared, "d-any", 1)).toBe("import");
    // Not just "the second": ANY index past the first. A guard written
    // `index === 1 ? "import" : ...` would pass the line above and fail here.
    expect(playModeFor(undeclared, "d-any", 7)).toBe("import");
  });

  it("treats an EMPTY declaration exactly as no declaration — the empty case, stated first", () => {
    // An empty map answers "no" to every membership question and lands on the
    // default. Stating it is what stops a later `play !== undefined` guard
    // from reading as "this suite declared something".
    expect(playModeFor({ play: {} }, "d-any", 0)).toBe("api");
    expect(playModeFor({ play: {} }, "d-any", 1)).toBe("import");
  });

  it("ignores a declaration that names a DIFFERENT division", () => {
    const def = { play: { "d-other": "tap" as PlayMode } };
    expect(playModeFor(def, "d-mine", 0)).toBe("api");
    expect(playModeFor(def, "d-mine", 1)).toBe("import");
  });
});

describe("playModeFor — a declared mode overrides the position", () => {
  it("moves the FIRST division off the single-event route when the suite says so", () => {
    // The positional answer here is "api". Asserting "import" is what makes
    // this a differential rather than a reachability check: a helper that
    // never read `play` would return "api" and this line alone would catch it.
    expect(playModeFor({ play: { "d-zero": "import" as PlayMode } }, "d-zero", 0)).toBe("import");
  });

  it("moves a LATER division onto the single-event route when the suite says so", () => {
    // The mirror case, and the other direction of the same differential: the
    // positional answer at index 1 is "import".
    expect(playModeFor({ play: { "d-one": "api" as PlayMode } }, "d-one", 1)).toBe("api");
  });

  it("returns tap as a mode of its own rather than folding it into either write path", () => {
    // `tap` has no writer until Task 10. This helper's job is to REPORT it;
    // refusing it here would put the refusal in the wrong layer and leave the
    // runner unable to tell "not declared" from "declared unplayable".
    expect(playModeFor({ play: { "d-tap": "tap" as PlayMode } }, "d-tap", 0)).toBe("tap");
    expect(playModeFor({ play: { "d-tap": "tap" as PlayMode } }, "d-tap", 3)).toBe("tap");
  });

  it("reads each division's own row, never the first row it finds", () => {
    // One declaration, three divisions, three different answers — the shape a
    // real multi-division suite has. A lookup that returned the map's first
    // value, or that keyed on the index instead of the ref, passes every
    // single-row case above and fails here.
    const def = {
      play: { "d-a": "tap" as PlayMode, "d-b": "api" as PlayMode, "d-c": "import" as PlayMode },
    };
    expect([
      playModeFor(def, "d-a", 0),
      playModeFor(def, "d-b", 1),
      playModeFor(def, "d-c", 2),
      playModeFor(def, "d-undeclared", 3),
    ]).toEqual(["tap", "api", "import", "import"]);
  });
});
