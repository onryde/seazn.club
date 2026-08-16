// Hardening driven by the 2026-08-16 parse bench, where the shipped model
// (claude-haiku-4-5) invented TEN constraints across 35 cases — and every one
// landed on a row whose wording the schema has no vocabulary for. On rows it
// could express, it invented nothing and scored 17/18.
//
// So the model is competent at the mapping and bad at REFUSING. These tests
// close the three refusal holes that need no engine work.
import { describe, expect, it } from "vitest";
import { makeClock } from "@seazn/engine/scheduling";

import {
  PARSER_PROMPT,
  PARSE_TOKEN_CEILING,
  PARSE_TOKENS_PER_ATTEMPT,
  RawParsed,
  resolveParsed,
} from "../schedule-ai-parse";

const TZ = "Europe/London";
const CLOCK = makeClock(Date.parse("2026-08-03T09:00:00Z"), TZ);
const COMPETITION = { kind: "competition" } as const;
const DIVISION = { kind: "division", divisionId: "d1" } as const;

const parse = (hard: unknown[]) => RawParsed.safeParse({ hard, soft: [], unparsed: [] });
const resolve = (hard: unknown[]) =>
  resolveParsed(RawParsed.parse({ hard, soft: [], unparsed: [] }), CLOCK, TZ);

describe("Selector no longer offers a field the model is never shown", () => {
  it("rejects an ext_key selector", () => {
    // ParserContext carries divisions and NOTHING else — no fixture is ever
    // shown to the model. So `ext_key` could only ever be populated by
    // invention, and on bench row t03 ("put the semifinals on Friday") that is
    // exactly what happened: extKey "semifinals", binding to no fixture.
    const res = parse([
      {
        type: "fixture_on_weekday",
        selector: { kind: "ext_key", extKey: "semifinals" },
        weekday: "FRI",
        scope: COMPETITION,
      },
    ]);
    expect(res.success).toBe(false);
  });

  it("still accepts the terminal selector", () => {
    const res = parse([
      {
        type: "fixture_on_weekday",
        selector: { kind: "terminal" },
        weekday: "FRI",
        scope: COMPETITION,
      },
    ]);
    expect(res.success).toBe(true);
  });
});

describe("contradictory rules are refused, not silently applied", () => {
  it("drops two different caps stated for the same scope", () => {
    // Bench row c02: "6 matches on Saturday and 4 on Sunday" produced
    // max_fixtures_per_day 6 AND 4, both competition-scoped. Whichever the
    // solver read, the organiser was told something untrue.
    const out = resolve([
      { type: "max_fixtures_per_day", count: 6, scope: COMPETITION },
      { type: "max_fixtures_per_day", count: 4, scope: COMPETITION },
    ]);

    expect(out.hard).toEqual([]);
    expect(out.unparsed.length).toBe(1);
    expect(out.unparsed[0]).toContain("max_fixtures_per_day");
  });

  it("keeps the same rule type at genuinely different scopes", () => {
    // Bench row d05: "3 a day overall but Open Singles no more than 1 a day"
    // is not a contradiction — it is two rules about two different things.
    const out = resolve([
      { type: "max_fixtures_per_day", count: 3, scope: COMPETITION },
      { type: "max_fixtures_per_day", count: 1, scope: DIVISION },
    ]);

    expect(out.hard.length).toBe(2);
    expect(out.unparsed).toEqual([]);
  });

  it("keeps two rest rules that differ by rest_scope", () => {
    // Bench row c07: "45 minutes between a player's own matches and 30 minutes
    // before the round they feed into" is two distinct bounds, not a conflict.
    const out = resolve([
      { type: "min_rest_minutes", minutes: 45, rest_scope: "per_person", scope: COMPETITION },
      { type: "min_rest_minutes", minutes: 30, rest_scope: "feeder_to_dependent", scope: COMPETITION },
    ]);

    expect(out.hard.length).toBe(2);
    expect(out.unparsed).toEqual([]);
  });

  it("drops two rest rules that share a rest_scope but disagree", () => {
    const out = resolve([
      { type: "min_rest_minutes", minutes: 45, rest_scope: "per_person", scope: COMPETITION },
      { type: "min_rest_minutes", minutes: 60, rest_scope: "per_person", scope: COMPETITION },
    ]);

    expect(out.hard).toEqual([]);
    expect(out.unparsed.length).toBe(1);
  });

  it("drops conflicting wall-clock bounds", () => {
    const out = resolve([
      { type: "not_before", time: "09:00", scope: COMPETITION },
      { type: "not_before", time: "12:00", scope: COMPETITION },
    ]);

    expect(out.hard).toEqual([]);
    expect(out.unparsed.length).toBe(1);
  });

  it("collapses an exact duplicate silently, because it says nothing new", () => {
    const out = resolve([
      { type: "max_fixtures_per_day", count: 2, scope: COMPETITION },
      { type: "max_fixtures_per_day", count: 2, scope: COMPETITION },
    ]);

    expect(out.hard.length).toBe(1);
    expect(out.unparsed).toEqual([]);
  });

  it("leaves an unrelated rule standing when another pair conflicts", () => {
    const out = resolve([
      { type: "max_fixtures_per_day", count: 6, scope: COMPETITION },
      { type: "max_fixtures_per_day", count: 4, scope: COMPETITION },
      { type: "not_after", time: "20:00", scope: COMPETITION },
    ]);

    expect(out.hard).toEqual([{ type: "not_after", time: "20:00", scope: COMPETITION }]);
    expect(out.unparsed.length).toBe(1);
  });
});

describe("the pre-flight's token budget", () => {
  it("keeps the corrective retry reachable after a first attempt that truncated", () => {
    // The retry is needed EXACTLY when the first attempt ran out of room, which
    // means it spent its whole per-attempt cap. If that cap were half the
    // ceiling or more, `clampRound` returns 0 on the second pass and the loop
    // breaks without ever retrying — the retry would exist only for the cases
    // that never needed it. Raising the ceiling on 2026-08-16 (2k -> 5k, after
    // the two longest bench rows kept landing as schema misses) is exactly the
    // sort of edit that can silently violate this, so it is asserted rather
    // than left as a comment.
    //
    // NON-strict, deliberately. schedule-ai-parse.ts's own comment says the
    // per-attempt cap must be "STRICTLY under half the ceiling" because a
    // truncating first attempt "has spent the whole ceiling" — but
    // clampRound is max(0, min(cap, budget - spent)), so at exactly half a
    // truncating attempt leaves exactly one more full attempt. The shipped
    // values were 1000/2000, i.e. exactly half, and the retry worked. The real
    // requirement is that two full attempts fit.
    expect(PARSE_TOKENS_PER_ATTEMPT * 2).toBeLessThanOrEqual(PARSE_TOKEN_CEILING);
  });

  it("gives a single attempt room for the longest instructions seen on the bench", () => {
    // Gemini averaged ~474 output tokens per case but schema-missed on the two
    // longest multi-clause rows, which is what a truncated answer looks like
    // from the outside — parseInstruction cannot tell "ran out of room" from
    // "answered wrongly".
    expect(PARSE_TOKENS_PER_ATTEMPT).toBeGreaterThanOrEqual(2_000);
  });
});

describe("the prompt closes the two holes the bench drove through", () => {
  it("forbids emitting a calendar date the instruction did not contain", () => {
    // Rule 1 already says "you have no calendar", yet haiku emitted
    // {"kind":"date","date":"2024-01-03"} on two rows — a fabricated date, in
    // the past, in a 2026 system. The rule needs to bind the `date` VARIANT,
    // not just the concept.
    expect(PARSER_PROMPT).toContain("only if the instruction itself contains");
  });

  it("says which of soft and unparsed wins for an unenforceable preference", () => {
    // Three arms disagreed on "avoid clashing with the football final on TV".
    // The prompt never said which bucket wins, so the disagreement was ours.
    expect(PARSER_PROMPT).toContain("prefer soft");
  });
});
