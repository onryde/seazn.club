// Scorer sheets §4.3 — THE EMPTY CASE FIRST. A "does any clause hold" rule
// answers no on the empty set and falls to the default; the default here is
// "the umpire may still act", so a predicate that silently answered no forever
// would pass every "contains X" test written after it.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOCKED_FIXTURE_STATUSES } from "@/server/engine-db/append-event";
import { buildOpenApiDocument } from "@/server/api-v1/openapi";
import { NOT_CARRIED, RESULT_CARRIED_FORWARD, SETTLED_OPEN_STATUSES, isCarriedForward } from "../carried-forward";

// Review m4: the refusal is part of THE scoring endpoint's wire contract, so
// the OpenAPI document an integrator reads must list the 403 and name its code
// — read from the constant scoring.ts throws, never retyped here.
describe("the scoring endpoint documents the carried-forward refusal", () => {
  it.each([
    ["full", buildOpenApiDocument()],
    ["published", buildOpenApiDocument({ published: true })],
  ] as const)("%s spec: POST …/fixtures/{id}/events lists 403 and names RESULT_CARRIED_FORWARD", (_, doc) => {
    const paths = (doc as { paths: Record<string, Record<string, { summary?: string; responses: Record<string, unknown> }>> }).paths;
    const key = Object.keys(paths).find((p) => p.endsWith("/fixtures/{id}/events"));
    expect(key, "the events route is in the spec").toBeDefined();
    const post = paths[key!]!.post!;
    expect(Object.keys(post.responses)).toContain("403");
    expect(post.summary).toContain(RESULT_CARRIED_FORWARD);
  });
});

describe("isCarriedForward", () => {
  it("empty case: no feed filled, no later Swiss round, stage open → NOT carried", () => {
    expect(isCarriedForward(NOT_CARRIED)).toBe(false);
  });

  it.each([
    ["winnerFeedFilled"],
    ["loserFeedFilled"],
    ["swissNextRoundSeated"],
    ["stageComplete"],
  ] as const)("%s alone → carried", (clause) => {
    expect(isCarriedForward({ ...NOT_CARRIED, [clause]: true })).toBe(true);
  });
});

describe("SETTLED_OPEN_STATUSES", () => {
  it("is every fixture status that is neither open nor locked — derived from the fixtures CHECK constraint", () => {
    const ddl = readFileSync(
      resolve(import.meta.dirname, "../../../../../../db/migration/v2-engine/tables/V214__fixtures.sql"),
      "utf8",
    );
    const list = ddl.match(/status\s+text[^;]*?check \(status in\s*\(([^)]*)\)/s)?.[1];
    expect(list, "V214's fixtures.status CHECK moved — re-derive").toBeDefined();
    const all = [...list!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    const expected = all.filter((s) => s !== "scheduled" && s !== "in_play" && !LOCKED_FIXTURE_STATUSES.has(s));
    expect([...SETTLED_OPEN_STATUSES].sort()).toEqual(expected.sort());
    // The differential: the open statuses are NOT in it, or the refusal would stop live scoring.
    expect(SETTLED_OPEN_STATUSES.has("in_play")).toBe(false);
    expect(SETTLED_OPEN_STATUSES.has("scheduled")).toBe(false);
  });
});
