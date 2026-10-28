// W2e Task 2 review (M1) — POST /api/v1/fixtures/{id}/events with an `expected_seq` past int4 (the type of
// `score_events.seq`, V216) answers 400 VALIDATION at the door, through the real route and its real `v1` / `parseBody`.
// Before the bound it passed the door and reached SQL that compares it with the int4 column (`isOwnSanctionEnding`), where
// Postgres raised "out of range for type integer" — a 500. The door refuses before auth and before any query, so this
// test needs no database.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { POST } from "../route";

function post(expectedSeq: number): Request {
  return new Request(`http://localhost/api/v1/fixtures/${randomUUID()}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expected_seq: expectedSeq,
      type: "core.forfeit",
      payload: { by: "A", reason: "disqualified" },
    }),
  });
}

describe("POST /fixtures/{id}/events — expected_seq is bounded to int4 at the door (W2e M1)", () => {
  it("2^31 and beyond answer 400 VALIDATION naming expected_seq, never a 500 (counted)", async () => {
    let checked = 0;
    for (const huge of [2 ** 31, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
      const res = await POST(post(huge), { params: Promise.resolve({ id: randomUUID() }) });
      expect(res.status, String(huge)).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("VALIDATION");
      expect(JSON.stringify(body.error)).toContain("expected_seq");
      checked++;
    }
    expect(checked).toBe(3);
  });
});
