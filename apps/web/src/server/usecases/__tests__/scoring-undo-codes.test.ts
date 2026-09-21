import { describe, expect, it } from "vitest";
import { HttpError } from "@/lib/errors";
import { __assertUndoTargetForTests as assertUndoTarget } from "../scoring";

const auth = { orgId: "00000000-0000-4000-8000-000000000001", userId: "u" } as never;
const FIXTURE = "00000000-0000-4000-8000-0000000000ff";

// Only the two payload-shape cases live here: they refuse BEFORE the ledger
// lookup, so they need no fixture row. The three DB-backed refusals
// (UNDO_TARGET_MISSING, UNDO_ALREADY_VOIDED, UNDO_NOT_UNDOABLE) are covered
// end-to-end by the wave's regression e2e. They are deliberately NOT faked
// with a mocked `withTenant` — a mock there would assert the mock.
describe("assertUndoTarget wire codes", () => {
  it("a malformed event_id is UNDO_NOOP, not a bare CONFLICT", async () => {
    const err = await assertUndoTarget(auth, FIXTURE, {
      type: "core.void",
      payload: { event_id: "not-a-uuid" },
      expected_seq: 1,
    } as never).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(409);
    expect((err as HttpError).code).toBe("UNDO_NOOP");
  });

  it("a missing payload is UNDO_NOOP", async () => {
    const err = await assertUndoTarget(auth, FIXTURE, {
      type: "core.void",
      payload: null,
      expected_seq: 1,
    } as never).catch((e) => e);
    expect((err as HttpError).code).toBe("UNDO_NOOP");
  });
});
