// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data } from "../harness.ts";

/**
 * D2 capacity pre-check (own fresh free session — not an entitlement gate):
 * one impossible + one ok assessment through the REAL /schedule/auto route,
 * proving the server is the authority (422 CAPACITY_IMPOSSIBLE with the
 * report attached), not only the UI's client-side recompute.
 */
export async function capacityPrecheckSuite(): Promise<void> {
  const free = newSession();
  const capacityOrgId = (await signIn(free, `delivered+dtx_free_${tag}@resend.dev`)).org_id;
  const capacityVenue = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${capacityOrgId}/venues`, "POST", { name: `Capacity Venue ${tag}` }),
  );
  const capacityCourt = v1data<{ id: string }>(
    await v1(free, `/api/v1/orgs/${capacityOrgId}/venues/${capacityVenue.id}/courts`, "POST", {
      name: "Court 1",
    }),
  );
  const comp = v1data<{ id: string }>(
    await v1(free, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `DTX Capacity ${tag}`,
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(free, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Capacity",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  await v1(free, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: "A", seed: 1 },
    { kind: "individual", display_name: "B", seed: 2 },
    { kind: "individual", display_name: "C", seed: 3 },
    { kind: "individual", display_name: "D", seed: 4 },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(free, `/api/v1/divisions/${div.id}/stages`, "POST", { seq: 1, kind: "league", name: "L", config: {} }),
  );
  await v1(free, `/api/v1/stages/${stage.id}/generate`, "POST");

  // 4-entrant round robin = 6 fixtures. ONE court, ONE calendar day; only
  // `sessionWindows` differs between the two calls below — the single knob
  // that flips supply from 1 slot (impossible) to comfortably ample (ok).
  const putSettings = (sessionWindows: { from: string; to: string }[]) =>
    v1(free, `/api/v1/divisions/${div.id}/schedule-settings`, "PUT", {
      tz: "UTC",
      config: {
        startAt: "2026-08-01T09:00:00.000Z",
        endAt: "2026-08-01T23:59:00.000Z",
        matchMinutes: 60,
        gapMinutes: 0,
        courts: [capacityCourt.id],
        perEntrantMinRest: 0,
        sessionWindows,
      },
    });

  await putSettings([{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T10:00:00.000Z" }]); // 1h -> 1 slot
  const impossible = await v1(free, `/api/v1/stages/${stage.id}/schedule/auto`, "POST", { only_unlocked: true });
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- eslint reads this as unnecessary and tsc does not: the shared error type carries no `capacity_report`, so deleting the assertion fails `tsc -p tsconfig.scripts.json --noEmit` with TS2339. Verified 2026-09-06.
  const impossibleErr = impossible.json.error as { code?: string; capacity_report?: { verdict?: string } } | undefined;
  check(
    "capacity precheck: an arithmetically-impossible board is refused 422 CAPACITY_IMPOSSIBLE with a report",
    impossible.status === 422 &&
      impossibleErr?.code === "CAPACITY_IMPOSSIBLE" &&
      impossibleErr?.capacity_report?.verdict === "impossible",
  );

  await putSettings([{ from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T21:00:00.000Z" }]); // 12h -> 12 slots
  const ok = await v1(free, `/api/v1/stages/${stage.id}/schedule/auto`, "POST", { only_unlocked: true });
  check("capacity precheck: a comfortable board proceeds through the real route (200, not refused)", ok.status === 200);
}
