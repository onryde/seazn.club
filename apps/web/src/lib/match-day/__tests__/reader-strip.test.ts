// Match Day PB2 item 3: `matchDayForReader` is the ONE strip both Match Day doors use — the page's first paint (task G5) and the
// poll the shell runs after it (the route). Pure, so the owed-result count is pinned here deterministically; the route's own
// test (read-only-staff.test.ts) drives real sessions through it.
//
// The predicate is the page's: `isEditorRole` is what page-auth.ts computes `canEdit` from (owner, admin). Every role the
// organisation has is enumerated off ORG_ROLES itself, plus the API key's null role, so a new role cannot slip past unasked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ORG_ROLES, EDITOR_ROLES, isEditorRole, type OrgRole } from "@/lib/types";
import { matchDayForReader } from "@/lib/match-day/view";
import type { MatchDayView } from "@/lib/match-day/types";

type Strip = Pick<MatchDayView, "needs_you" | "results_owed"> & { courts: string[]; fixtures_today: number };
const ROW = { key: "k-1", severity: "red" as const, kind: "result_missing" as const, title: "Result owed", sub: "Court 1", action: { label: "Open", href: "/x" } };
const VIEW: Strip = { needs_you: [ROW, { ...ROW, key: "k-2", kind: "unscheduled" as const }], results_owed: 3, courts: ["c-1", "c-2"], fixtures_today: 7 };

describe("matchDayForReader — the organiser's to-do list reaches organisers only", () => {
  it("EMPTY CASE FIRST: a view with no rows and nothing owed is the same for every reader", () => {
    const empty: Strip = { ...VIEW, needs_you: [], results_owed: 0 };
    expect(matchDayForReader(empty, true)).toEqual(empty);
    expect(matchDayForReader(empty, false)).toEqual(empty);
  });

  it("an organiser gets the view whole — the same object, rows and count", () => {
    expect(matchDayForReader(VIEW, true)).toBe(VIEW);
  });

  it("anyone else gets no rows and a zero owed count, and the rest of the board untouched; the input is not mutated", () => {
    const out = matchDayForReader(VIEW, false);
    expect(out.needs_you).toEqual([]);
    expect(out.results_owed).toBe(0);
    expect({ courts: out.courts, fixtures_today: out.fixtures_today }).toEqual({ courts: VIEW.courts, fixtures_today: VIEW.fixtures_today });
    expect(VIEW.needs_you).toHaveLength(2);
    expect(VIEW.results_owed).toBe(3);
  });

  it("the predicate, per role: owner and admin are organisers; viewer and an API key (role null) are not", () => {
    const want: Record<OrgRole, boolean> = { owner: true, admin: true, viewer: false };
    let checked = 0;
    for (const role of ORG_ROLES) {
      expect(isEditorRole(role), role).toBe(want[role]);
      expect(isEditorRole(role), `${role} agrees with EDITOR_ROLES`).toBe((EDITOR_ROLES as readonly string[]).includes(role));
      const out = matchDayForReader(VIEW, isEditorRole(role));
      expect(out.needs_you.length, role).toBe(want[role] ? 2 : 0);
      checked++;
    }
    expect(checked, "anti-vacuity: every org role").toBe(ORG_ROLES.length);
    expect(isEditorRole(null), "an API key").toBe(false);
  });

  it("fix round 1 (m3): the console pages' canEdit is the SAME predicate — page-auth.ts asks isEditorRole and never re-spells EDITOR_ROLES", () => {
    const src = readFileSync(join(process.cwd(), "src/server/page-auth.ts"), "utf8");
    const asks = src.match(/\bisEditorRole\(/g) ?? [];
    expect(asks.length, "page-auth computes canEdit through isEditorRole").toBeGreaterThan(0);
    expect(src, "no second spelling of the editor set").not.toMatch(/EDITOR_ROLES/);
  });
});
