// The published API states the online chess entrant cap in words - "holds at most N", "the N+1th is 422 ONLINE_DIVISION_FULL" - on
// every route whose refusal it is. Those are typed numbers in openapi.ts (its generator runs under bare node, which cannot reach
// lib/online-chess.ts through its `@/` import), so nothing moved them when the cap did: this pins every one of them to the constant.
// Raised 128 -> 256 on 2026-11-23; a summary still saying 128 is a customer reading the wrong limit.
import { describe, expect, it } from "vitest";
import { ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION, ONLINE_DIVISION_FULL, ONLINE_PLAY_TOO_MANY_ENTRANTS } from "@/lib/online-chess";
import { ROUTES } from "../openapi";

const MAX = ONLINE_CHESS_MAX_ENTRANTS_PER_DIVISION;

/** The clauses (split on `;` and sentence ends) of a summary that speak of the online cap: they name its refusal code or an online
 *  chess division's size. */
function capClauses(summary: string): string[] {
  return summary
    .split(/;|\.\s/)
    .filter((c) => c.includes(ONLINE_DIVISION_FULL) || c.includes(ONLINE_PLAY_TOO_MANY_ENTRANTS) || /online chess division holds/.test(c));
}

describe("openapi: every summary that states the online cap states the constant", () => {
  it("each number in an online-cap clause is the cap or the first entrant past it - every route checked", () => {
    let routes = 0;
    let numbers = 0;
    for (const r of ROUTES) {
      const clauses = capClauses(r.summary);
      if (clauses.length === 0) continue;
      routes += 1;
      for (const clause of clauses) {
        // Every number but an HTTP status (one followed by its error code: "422 ONLINE_DIVISION_FULL").
        for (const m of clause.matchAll(/\b(\d+)(?:th)?\b(?!\s+[A-Z][A-Z_]{2,})/g)) {
          expect([MAX, MAX + 1], `${r.method.toUpperCase()} ${r.path}: "${clause.trim()}"`).toContain(Number(m[1]));
          numbers += 1;
        }
      }
    }
    // Anti-vacuity: the routes that publish the cap today - the online switch (PATCH division), the add door, the capacity save,
    // and confirm / waive / promote - and at least one number on each.
    expect(routes, "routes whose summary states the online cap").toBeGreaterThanOrEqual(6);
    expect(numbers, "numbers checked").toBeGreaterThanOrEqual(routes);
  });
});
