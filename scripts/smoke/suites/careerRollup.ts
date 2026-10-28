// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, check, tag, v1, v1data } from "../harness.ts";

/**
 * S9/#418 — the career rollup (`?group=sport`). Gives the SAME person a second
 * football division and asserts the career total is the SUM, not either
 * division's own figure: a rollup that silently returned the first row would
 * still read 1 goal here and look right, which is the whole reason this needs
 * a second division rather than a second assertion on the first.
 *
 * The person keeps goal in this second division and played out in the first,
 * so the football card also has to carry outfield and goalkeeper metrics at
 * once — the "one card, correct splits" criterion.
 */
export async function careerRollupSuite(
  admin: Session,
  scorerId: string,
  opponentId: string,
): Promise<void> {
  const before = v1data<{ sports: { sport_key: string; metrics: { key: string; value: number }[]; divisions: number }[] }>(
    await v1(admin, `/api/v1/persons/${scorerId}/stats?group=sport`),
  );
  const beforeFootball = before.sports.find((s) => s.sport_key === "football");
  check("career: ?group=sport returns a football card", beforeFootball !== undefined);
  check(
    "career: one division so far, and it is the goal already scored",
    beforeFootball?.divisions === 1 &&
      beforeFootball.metrics.find((m) => m.key === "goals")?.value === 1,
  );

  const comp2 = v1data<{ id: string }>(
    await v1(admin, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Career Second ${tag}`,
      visibility: "public",
    }),
  );
  const div2 = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp2.id}/divisions`, "POST", {
      name: "Second", sport_key: "football", variant_key: "11-a-side",
    }),
  );
  const ents2 = v1data<{ id: string }[]>(
    await v1(admin, `/api/v1/divisions/${div2.id}/entrants`, "POST", [
      { kind: "team", display_name: `Keepers ${tag}`, seed: 1, members: [{ person_id: scorerId }] },
      { kind: "team", display_name: `Strikers ${tag}`, seed: 2, members: [{ person_id: opponentId }] },
    ]),
  );
  const home2 = ents2[0].id;
  const away2 = ents2[1].id;
  const stage2 = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div2.id}/stages`, "POST", { seq: 1, kind: "league", name: "League" }),
  );
  const fx2 = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stage2.id}/generate`, "POST"),
  ).fixtures;
  check("career: second football fixture generated", fx2.length >= 1);
  await v1(admin, `/api/v1/divisions/${div2.id}/start`, "POST");
  const fixture2 = fx2[0].id;

  // GK on the starting sheet is all the keeper fold needs — no
  // core.lineup.position event is required to make this person the keeper.
  await v1(admin, `/api/v1/fixtures/${fixture2}/lineups/${home2}`, "PUT", {
    slots: [{ person_id: scorerId, slot: "starting", position_key: "GK", order_no: 1, roles: [] }],
  });
  await v1(admin, `/api/v1/fixtures/${fixture2}/lineups/${away2}`, "PUT", {
    slots: [{ person_id: opponentId, slot: "starting", position_key: "FW", order_no: 1, roles: [] }],
  });
  const started2 = v1data<{ seq: number }>(
    await v1(admin, `/api/v1/fixtures/${fixture2}/events`, "POST", {
      expected_seq: 0, type: "core.start", payload: {},
    }),
  );
  const conceded = await v1(admin, `/api/v1/fixtures/${fixture2}/events`, "POST", {
    expected_seq: started2.seq,
    type: "football.goal",
    payload: { by: away2, scorer: opponentId },
  });
  check("career: opponent's goal accepted against the keeper", conceded.status < 300);

  // Materialise the second division's snapshot. The career read is
  // snapshot-only by design — it never recomputes — so a division nobody has
  // ever looked at contributes nothing, and asserting before this would fail
  // for the wrong reason.
  await v1(admin, `/api/v1/divisions/${div2.id}/stats/players`);

  const after = v1data<{ sports: { sport_key: string; metrics: { key: string; value: number }[]; divisions: number }[] }>(
    await v1(admin, `/api/v1/persons/${scorerId}/stats?group=sport`),
  );
  const football = after.sports.find((s) => s.sport_key === "football");
  check("career: both football divisions roll into one card", football?.divisions === 2);
  check(
    "career: the goal from division one survives the sum",
    football?.metrics.find((m) => m.key === "goals")?.value === 1,
  );
  check(
    "career: the same card carries a goalkeeper metric from the other division",
    football?.metrics.some((m) => m.key === "goals_conceded" && m.value === 1) === true,
  );

  // The param is additive: no `group` keeps the per-division list intact.
  const perDivision = v1data<{ divisions: { division_id: string }[] }>(
    await v1(admin, `/api/v1/persons/${scorerId}/stats`),
  );
  check("career: ungrouped read still lists divisions", perDivision.divisions.length >= 2);

  // An unrecognised value is not a silent switch into the new shape.
  const bogus = v1data<{ divisions?: unknown[]; sports?: unknown[] }>(
    await v1(admin, `/api/v1/persons/${scorerId}/stats?group=nonsense`),
  );
  check("career: an unknown group value falls back to per-division", Array.isArray(bogus.divisions));
}
