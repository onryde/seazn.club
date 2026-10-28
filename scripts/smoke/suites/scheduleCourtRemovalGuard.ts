// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * Date/time UX programme, Prompt 09 — the court-removal guard
 * (`putScheduleSettings`, "date/time UX P08", usecases/schedule.ts): dropping
 * a court that still holds a PINNED fixture is refused (409, naming the court
 * and the reason); the identically-shaped save is allowed once that fixture
 * is unpinned. The guard's reasoning matrix (both refusal reasons, the
 * combination, the widened-but-not-too-widened boundary) is already
 * exhaustively unit-tested (usecases/__tests__/schedule.test.ts) — this
 * proves the real HTTP PUT route reaches it end to end, over the wire, with
 * no mocks.
 *
 * NOT an entitlement check (V353/#382 opened multi-court scheduling to every
 * plan), so this needs no Pro org — own fresh free session.
 *
 * Control-run idiom: the SAME division, the SAME shaped PUT, ONE fixture's
 * lock toggled — pinned is refused, unpinned is not. If the guard regressed
 * to always-409 (over-widened to "any fixture on the court") or always-200
 * (a no-op), one half of this would fail.
 */
export async function scheduleCourtRemovalGuardSuite(): Promise<void> {
  const free = newSession();
  const freeOrgId = (await signIn(free, `delivered+dtx_free_${tag}@resend.dev`)).org_id;
  const guardVenue = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${freeOrgId}/venues`, "POST", { name: `Guard Venue ${tag}` }),
  );
  const guardCourt1 = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${freeOrgId}/venues/${guardVenue.id}/courts`, "POST", {
      name: "Court 1",
    }),
  );
  const guardCourt2 = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${freeOrgId}/venues/${guardVenue.id}/courts`, "POST", {
      name: "Court 2",
    }),
  );
  const comp = v1data<{ id: string }>(
    await v1(free, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `DTX Court Guard ${tag}`,
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(free, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Court Guard",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(free, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: "A", seed: 1 },
    { kind: "individual", display_name: "B", seed: 2 },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(free, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "L",
      config: {},
    }),
  );
  const gen = v1data<{ fixtures: { id: string }[] }>(
    await v1(free, `/api/v1/stages/${stage.id}/generate`, "POST"),
  );
  const fixtureId = gen.fixtures[0].id;

  const putCourts = (courts: string[]) =>
    v1(free, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: {
        startAt: new Date(Date.UTC(2026, 9, 19, 9, 0)).toISOString(),
        matchMinutes: 30,
        gapMinutes: 0,
        courts,
      },
    });
  await putCourts([guardCourt1.id, guardCourt2.id]);
  await v1(free, `/api/v1/fixtures/${fixtureId}`, "PATCH", {
    scheduled_at: new Date(Date.UTC(2026, 9, 19, 9, 0)).toISOString(),
    court_id: guardCourt2.id,
  });
  await v1(free, `/api/v1/fixtures/${fixtureId}`, "PATCH", { schedule_locked: true });

  const refused = await putCourts([guardCourt1.id]);
  const refusedMsg = (refused.json.error)?.message ?? "";
  check(
    "schedule court-removal guard: dropping a court with a pinned fixture is refused (409, names the court + reason)",
    refused.status === 409 && /Court 2/.test(refusedMsg) && /pinned/i.test(refusedMsg),
  );

  // The control — the identically-shaped save once the fixture is unpinned.
  await v1(free, `/api/v1/fixtures/${fixtureId}`, "PATCH", { schedule_locked: false });
  const allowed = await putCourts([guardCourt1.id]);
  check(
    "schedule court-removal guard: the identically-shaped save is allowed once unpinned",
    allowed.status === 200,
  );
}
