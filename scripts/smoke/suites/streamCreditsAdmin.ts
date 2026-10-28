// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { BASE, type Session, cookieHeader, raw, check, setStaff } from "../harness.ts";

/** Streaming R1, Task 7A — the staff "Match credits" panel's route and mount over real HTTP.
 *  Guard first (non-staff 401), then as staff: the page ships the panel's CLOSED state, two grants
 *  move the balance by exactly their deltas, a replayed key moves nothing, a revoke above the
 *  balance is a 422, a session-linked refund naming a session this org does not have is a 404, a
 *  blank note is refused. The target is the admin's own fresh org; no other suite reads its
 *  org_stream_credits (Task 16's streamRelaySuite mints its own owner). The linked refund's CAP
 *  (422) is not driven here: a real consumed session needs a sealed rtmp column and the fixture
 *  snapshot columns, which this suite does not seed; the route test and Task 7's usecase test own
 *  the cap.
 *
 *  OPTION B's consequence for THIS suite (owner ruling 2026-09-27): the adjustment fields live
 *  inside a Modal that renders only while `open` is true, so the server HTML carries the section,
 *  the balance and the OPENER and nothing else. A smoke check for stream-credits-amount or
 *  -submit would be a FALSE red — it would be asserting that a closed modal is open. The fields
 *  are proven by the component test (their opening values) and the walkthrough (a person using
 *  them); here the mount is proven by the two testids a closed panel really ships. */
export async function streamCreditsAdminSuite(admin: Session, staffEmail: string, orgId: string): Promise<void> {
  const path = `/api/admin/orgs/${orgId}/stream-credits`;
  const key = () => `smoke-${crypto.randomUUID()}`;
  const balanceOf = (r: { json: { data?: unknown } }) => (r.json.data as { balance?: number } | undefined)?.balance;
  const denied = await raw(admin, path, "POST", { kind: "grant", delta: 1, note: "smoke: must not land", idempotency_key: key() });
  check(`stream credits admin: non-staff POST → 401 (got ${denied.status})`, denied.status === 401);

  await setStaff(staffEmail, "superadmin");
  try {
    const page = await fetch(`${BASE}/admin/orgs/${orgId}`, { headers: { cookie: cookieHeader(admin) } });
    const html = await page.text();
    // Both testids, and the label, so the check cannot pass on an empty <section>: the panel is
    // the section AND its opener. A page that shipped the section with no way to open it would
    // be the inert seam this task exists to close (AGENTS.md class 1).
    const shipsPanel =
      html.includes('data-testid="stream-credits-panel"') &&
      html.includes('data-testid="stream-credits-adjust"') &&
      html.includes("Adjust credits");
    check(
      `stream credits admin: /admin/orgs/[id] ships the panel and its opener (got ${page.status})`,
      page.status === 200 && shipsPanel,
    );
    const replayKey = key();
    const first = await raw(admin, path, "POST", { kind: "grant", delta: 1, note: "smoke grant", idempotency_key: key() });
    const second = await raw(admin, path, "POST", { kind: "grant", delta: 2, note: "smoke grant 2", idempotency_key: replayKey });
    const b1 = balanceOf(first);
    const b2 = balanceOf(second);
    check(
      `stream credits admin: grants land and the balance moves by exactly the delta (${first.status}/${second.status}, ${String(b1)} → ${String(b2)})`,
      first.status === 200 && second.status === 200 && typeof b1 === "number" && b2 === b1 + 2,
    );
    const replay = await raw(admin, path, "POST", { kind: "grant", delta: 2, note: "smoke grant 2", idempotency_key: replayKey });
    const replayApplied = (replay.json.data as { applied?: boolean } | undefined)?.applied;
    check(
      `stream credits admin: a replayed key applies nothing (got ${replay.status}, applied ${String(replayApplied)}, ${String(b2)} → ${String(balanceOf(replay))})`,
      replay.status === 200 && replayApplied === false && typeof b2 === "number" && balanceOf(replay) === b2,
    );
    const over = await raw(admin, path, "POST", { kind: "revoke", delta: 50, note: "smoke: more than the balance", idempotency_key: key() });
    // `raw`'s json type carries no `code` (smoke.ts:76, type literal :81-88 — {ok,data?,error?,issues?});
    // `handler` forwards `code` on an HttpError (lib/http.ts:129-130) but DROPS `extra`, so a
    // refusal a client must act on has to arrive in `code` (re-pin FP-5).
    const overCode = (over.json as { code?: string }).code;
    check(
      `stream credits admin: a revoke above the balance → 422 insufficient_credits (got ${over.status} ${String(overCode)})`,
      over.status === 422 && overCode === "insufficient_credits",
    );
    // The session-linked refund body over real HTTP: a session id this org does not have is the
    // route's own 404, before Task 7's cap is reached, and nothing moves.
    const linked = await raw(admin, path, "POST", {
      kind: "refund", delta: 1, note: "smoke: linked refund", session_id: crypto.randomUUID(), idempotency_key: key(),
    });
    const linkedCode = (linked.json as { code?: string }).code;
    check(
      `stream credits admin: a session-linked refund naming a session this org does not have → 404 session_not_found (got ${linked.status} ${String(linkedCode)})`,
      linked.status === 404 && linkedCode === "session_not_found",
    );
    const blank = await raw(admin, path, "POST", { kind: "refund", delta: 1, note: "   ", idempotency_key: key() });
    check(`stream credits admin: a blank note is refused (got ${blank.status})`, blank.status === 400);
  } finally {
    await setStaff(staffEmail, null);
  }
}
