// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, check, tag, v1, v1data } from "../harness.ts";

// --- Page playoffs (IPL / spec 2026-07-19): template stages, feed wiring,
// second-life resolution — Q1's loser must land in Q2.
export async function pagePlayoffSuite(admin: Session): Promise<void> {
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `PP Cup ${tag}` }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Playoffs",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );
  const seeds = ["PP One", "PP Two", "PP Three", "PP Four"];
  await v1(
    admin,
    `/api/v1/divisions/${div.id}/entrants`,
    "POST",
    seeds.map((n, i) => ({
      kind: "individual",
      display_name: n,
      seed: i + 1,
      members: [],
    })),
  );
  const stage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "page_playoff",
      name: "Playoffs",
    }),
  );
  const gen = await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST");
  const fixtures = v1data<{
    fixtures: {
      id: string;
      round_no: number;
      seq_in_round: number;
      home_entrant_id: string | null;
      away_entrant_id: string | null;
    }[];
  }>(gen).fixtures;
  check("pp generates the four playoff fixtures", fixtures.length === 4);
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST");

  const entrants = v1data<{ id: string; display_name: string }[]>(
    await v1(admin, `/api/v1/divisions/${div.id}/entrants`),
  );
  const byName = new Map(entrants.map((e) => [e.display_name, e.id]));
  const q1 = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 1)!;
  const elim = fixtures.find((f) => f.round_no === 1 && f.seq_in_round === 2)!;
  check(
    "pp Q1 is 1 v 2",
    q1.home_entrant_id === byName.get("PP One") && q1.away_entrant_id === byName.get("PP Two"),
  );
  check(
    "pp Eliminator is 3 v 4",
    elim.home_entrant_id === byName.get("PP Three") &&
      elim.away_entrant_id === byName.get("PP Four"),
  );

  // Decide Q1 (Two beats One) + the Eliminator (Three wins) → Q2 must pair
  // One (Q1 loser) with Three (Eliminator winner); the Final holds Two.
  const decide = async (fid: string, a: number, b: number) => {
    const st = v1data<{ last_seq: number }>(await v1(admin, `/api/v1/fixtures/${fid}/state`));
    return v1(admin, `/api/v1/fixtures/${fid}/events`, "POST", {
      expected_seq: st.last_seq ?? 0,
      type: "generic.result",
      payload: { p1Score: a, p2Score: b },
    });
  };
  await decide(q1.id, 1, 2);
  await decide(elim.id, 3, 0);
  const q2f = v1data<{
    home_entrant_id: string | null;
    away_entrant_id: string | null;
  }>(await v1(admin, `/api/v1/fixtures/${fixtures.find((f) => f.round_no === 2)!.id}`));
  check(
    "pp Q2 = Q1 loser vs Eliminator winner",
    q2f.home_entrant_id === byName.get("PP One") && q2f.away_entrant_id === byName.get("PP Three"),
  );
  const finF = v1data<{ home_entrant_id: string | null }>(
    await v1(admin, `/api/v1/fixtures/${fixtures.find((f) => f.round_no === 3)!.id}`),
  );
  check("pp Final home = Q1 winner", finF.home_entrant_id === byName.get("PP Two"));
}
