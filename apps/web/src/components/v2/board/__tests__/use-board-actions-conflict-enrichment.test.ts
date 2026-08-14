// C3, 2026-08-13 design amendment — `use-board-actions.ts`'s SCHEDULE_CONFLICT
// error enrichment used to regex-scrape a UUID back out of the deprecated
// `detail` prose (`c.detail?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/i)?.[0]`) and
// take the FIRST match. For `person_overlap`/`entrant_overlap` the first id in
// that prose is the PERSON/ENTRANT, not the counterparty fixture, so
// `board.find(x => x.id === uuid)` missed and the enrichment silently
// degraded to "another match" instead of naming the real one. Reading
// `details.other_fixture_id` directly fixes it as a structural side effect.
//
// Driven through the shared hook dispatcher harness (`result-strip-wiring
// .test.tsx`'s own pattern) — vitest runs `environment: "node"` here, no
// jsdom, so a stateful island cannot be clicked.
import { beforeEach, describe, expect, it, vi } from "vitest";

const net = vi.hoisted(() => ({
  conflictsToThrow: null as unknown[] | null,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string }) => {
      if (options?.method === "PATCH" && net.conflictsToThrow) {
        return Promise.reject(
          new actual.ApiV1Error("clash", 409, "SCHEDULE_CONFLICT", { conflicts: net.conflictsToThrow }),
        );
      }
      return Promise.resolve({ conflicts: [] });
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

import { renderIsland } from "@/components/__tests__/_hook-harness";
import { useBoardActions, type BoardActions } from "../use-board-actions";
import type { BoardDivision, BoardFixture } from "../types";

const DIVISION = { id: "d1", name: "Open", seq: 3 } as unknown as BoardDivision;

// The fixture being moved.
const MOVER = {
  id: "f1",
  division_id: "d1",
  status: "scheduled",
  scheduled_at: "2026-08-05T10:00:00.000Z",
  court_label: "1",
  schedule_locked: false,
} as unknown as BoardFixture;

// The REAL counterparty — a genuine UUID id, so `board.find` can only
// succeed by reading `details.other_fixture_id`, never by falling through to
// some non-UUID id coincidentally matching.
const OTHER_FIXTURE_ID = "22222222-2222-2222-2222-222222222222";
const OTHER = {
  id: OTHER_FIXTURE_ID,
  division_id: "d1",
  status: "scheduled",
  scheduled_at: "2026-08-05T10:00:00.000Z",
  court_label: "2",
  schedule_locked: false,
  home_entrant_id: "e1",
  away_entrant_id: "e2",
} as unknown as BoardFixture;

const NAMES = { e1: "Alpha", e2: "Bravo" };
const LABELS = {};

function driveWith(fixtures: BoardFixture[]) {
  let latest: BoardActions | null = null;
  renderIsland(() => {
    latest = useBoardActions([DIVISION], fixtures, NAMES, LABELS, true);
    return null;
  }, {});
  return () => latest as BoardActions;
}

describe("moveCard's SCHEDULE_CONFLICT enrichment reads details.other_fixture_id, not a regex scrape", () => {
  beforeEach(() => {
    net.conflictsToThrow = null;
  });

  it("names the real counterparty match for a person_overlap conflict, not 'another match'", async () => {
    const PERSON_ID = "11111111-1111-1111-1111-111111111111";
    net.conflictsToThrow = [
      {
        fixture_id: "f1",
        code: "warn.person_overlap",
        blocking: true,
        // Realistic legacy prose (matches conflict-detail-legacy.ts's
        // `person_overlap` template byte for byte): the FIRST UUID-shaped
        // substring is the PERSON id, not the fixture id. The old regex
        // took this one — `board.find` then found nothing (no fixture has
        // the person's id) and silently said "another match".
        detail: `person ${PERSON_ID} overlap with ${OTHER_FIXTURE_ID}`,
        details: { kind: "person_overlap", person_ids: [PERSON_ID], other_fixture_id: OTHER_FIXTURE_ID },
      },
    ];
    const actions = driveWith([MOVER, OTHER]);

    await actions().moveCard("f1", "2026-08-05T10:00:00.000Z", "2");

    expect(actions().error).toContain("Alpha vs Bravo");
    expect(actions().error).not.toContain("another match");
  });

  it("still says 'another match' for a LEGITIMATE miss — other_fixture_id names a fixture genuinely not on this board", async () => {
    // Non-vacuity: a fix that always resolved SOME title (even a wrong one)
    // would pass the tests above by accident. This pins that `titleOf`'s own
    // fallback still works once it's reached honestly — `other_fixture_id`
    // is present and correct, but the fixture it names isn't in THIS
    // client's `board` (e.g. a cross-division reference).
    const PERSON_ID = "11111111-1111-1111-1111-111111111111";
    const UNKNOWN_FIXTURE_ID = "99999999-9999-9999-9999-999999999999";
    net.conflictsToThrow = [
      {
        fixture_id: "f1",
        code: "warn.person_overlap",
        blocking: true,
        details: { kind: "person_overlap", person_ids: [PERSON_ID], other_fixture_id: UNKNOWN_FIXTURE_ID },
      },
    ];
    // Board holds only MOVER — the referenced fixture genuinely isn't here.
    const actions = driveWith([MOVER]);

    await actions().moveCard("f1", "2026-08-05T10:00:00.000Z", "2");

    expect(actions().error).toContain("another match");
  });

  it("names the real counterparty for entrant_overlap too", async () => {
    const ENTRANT_ID = "33333333-3333-3333-3333-333333333333";
    net.conflictsToThrow = [
      {
        fixture_id: "f1",
        code: "warn.rest",
        blocking: true,
        detail: `entrant ${ENTRANT_ID} overlap with ${OTHER_FIXTURE_ID}`,
        details: { kind: "entrant_overlap", entrant_ids: [ENTRANT_ID], other_fixture_id: OTHER_FIXTURE_ID },
      },
    ];
    const actions = driveWith([MOVER, OTHER]);

    await actions().moveCard("f1", "2026-08-05T10:00:00.000Z", "2");

    expect(actions().error).toContain("Alpha vs Bravo");
    expect(actions().error).not.toContain("another match");
  });

  it("a conflict with no details at all still produces an error, without crashing", async () => {
    net.conflictsToThrow = [{ fixture_id: "f1", code: "warn.rest", blocking: true }];
    const actions = driveWith([MOVER, OTHER]);

    await actions().moveCard("f1", "2026-08-05T10:00:00.000Z", "2");

    expect(actions().error).toBeTruthy();
    expect(actions().error).not.toContain("another match");
  });
});
