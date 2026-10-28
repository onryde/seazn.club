// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, call, check, signIn, tag, html, v1, v1data } from "../harness.ts";

/**
 * F10 (2026-09-20 Swiss withdrawal walkthrough): the PUBLIC standings table
 * prints a withdrawn entrant's NAME, never her entrant id.
 *
 * Smoke rather than only e2e, for two reasons. Smoke is the only gate a PR gets
 * automatically — e2e.yml triggers on push to `main` alone — and this defect
 * lives in the seam between a DATABASE VIEW and a rendered page: V412 widened
 * `public_entrants_v` to publish departed entrants, the division page resolves
 * `entrantNames` from it, and `StandingsTable` falls through to
 * `row.entrantId` when it cannot. A view, a page and a fall-through; nothing
 * short of a real server, a real withdrawal and the real HTML sees all three at
 * once. The standings snapshot is keyed by entrant id and built from RESULTS,
 * so the row survives a withdrawal whatever the roster says — which is exactly
 * why the name has to.
 *
 * Own fresh free session (not an entitlement gate): a community org may publish
 * one public competition, which is all this needs.
 */
export async function publicWithdrawnStandingsSuite(): Promise<void> {
  const free = newSession();
  const ver = await signIn(free, `delivered+wd_board_${tag}@resend.dev`);
  const orgs = (await call(free, "/api/orgs")) as { id: string; slug: string }[];
  const org = orgs.find((o) => o.id === ver.org_id)!;

  const comp = v1data<{ id: string; slug: string }>(
    await v1(free, "/api/v1/competitions", "POST", {
      ends_on: "2030-12-31",
      name: `Withdrawn Board ${tag}`,
      visibility: "public",
    }),
  );
  const div = v1data<{ id: string; slug: string }>(
    await v1(free, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Open",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );

  const quitterName = `Ada Quitter ${tag}`;
  // TWO departures, not one. `inTheField` treats withdrawn and disqualified
  // alike, but a spectator must not — one entrant LEFT, the other was REMOVED
  // — and a suite that seeds only a withdrawal cannot see the two being
  // confused, because one chip satisfies "a chip is there" either way.
  const expelledName = `Eve Expelled ${tag}`;
  await v1(free, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: quitterName, seed: 1 },
    { kind: "individual", display_name: expelledName, seed: 2 },
    { kind: "individual", display_name: `Bo Stayer ${tag}`, seed: 3 },
    { kind: "individual", display_name: `Cy Stayer ${tag}`, seed: 4 },
  ]);
  const roster = v1data<{ id: string; display_name: string }[]>(
    await v1(free, `/api/v1/divisions/${div.id}/entrants`),
  );
  const quitterId = roster.find((e) => e.display_name === quitterName)!.id;
  const expelledId = roster.find((e) => e.display_name === expelledName)!.id;

  const stage = v1data<{ id: string }>(
    await v1(free, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1, kind: "league", name: "L", config: {},
    }),
  );
  const gen = v1data<{
    fixtures: { id: string; home_entrant_id: string | null; away_entrant_id: string | null }[];
  }>(await v1(free, `/api/v1/stages/${stage.id}/generate`, "POST"));
  await v1(free, `/api/v1/divisions/${div.id}/start`, "POST");

  const hers = gen.fixtures.filter(
    (f) => f.home_entrant_id === quitterId || f.away_entrant_id === quitterId,
  );
  const theirs = gen.fixtures.filter((f) => !hers.includes(f));
  // Half of HER games played, the rest left pending — and half is computed from
  // the board the generator actually produced, not typed in, so a change to the
  // fixture count moves this with it. The threshold is the engine's
  // (`withdrawTableEntrant`): BELOW half played it EXPUNGES — every game she
  // touched voids and the standings read as if she never entered — so she would
  // have no row at all and the UUID check below would pass on her absence. At
  // or above half the policy is AWARD and her results stand, which is the state
  // this suite exists to look at.
  const playedOfHers = hers.slice(0, Math.ceil(hers.length / 2));
  for (const f of [...theirs, ...playedOfHers]) {
    const st = v1data<{ last_seq: number }>(await v1(free, `/api/v1/fixtures/${f.id}/state`));
    await v1(free, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: st.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });
  }

  // The REAL withdrawal route with its fixture surgery, never a status UPDATE:
  // what the page reads has to be what an organiser's own action produces.
  const out = v1data<{ policy: string; voided: number }>(
    await v1(free, `/api/v1/entrants/${quitterId}/withdraw`, "POST"),
  );
  check(
    `public board: mid-tournament withdrawal awards rather than expunges, so her played result stands (policy=${out.policy}, voided=${out.voided})`,
    out.policy === "walkover" && out.voided === 0,
  );

  // The removal goes through the SAME route the roster editor's own
  // `onPatch({ status })` calls — there is no `/disqualify` endpoint, and a
  // direct UPDATE would prove only that the view reads a column somebody set.
  const dq = await v1(free, `/api/v1/entrants/${expelledId}`, "PATCH", { status: "disqualified" });
  check(
    `public board: an entrant can be disqualified through the real PATCH route (status=${dq.status})`,
    dq.status === 200 && v1data<{ status: string }>(dq).status === "disqualified",
  );

  const page = await html(newSession(), `/shared/${org.slug}/${comp.slug}/${div.slug}`);
  // The standings table's NAME CELLS, not the body. A whole-body grep cannot
  // make this assertion in either direction: the page carries entrant ids
  // legitimately (fixture hrefs, the embed snippet), so "no UUID in the body"
  // is false on a HEALTHY page; and the schedule's own entrant filter lists
  // every name, so "the body contains her name" is true on a broken one.
  const nameCells = [...page.body.matchAll(/<th scope="row"[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
    (m[1] ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
  );
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  check(
    `public board: both departed entrants' standings cells are NAMES, not UUIDs (${nameCells.length} name cells)`,
    page.status === 200 &&
      // A floor: an empty table satisfies "no cell holds a UUID" vacuously.
      nameCells.length >= 4 &&
      nameCells.some((c) => c.includes(quitterName)) &&
      nameCells.some((c) => c.includes(expelledName)) &&
      !nameCells.some((c) => uuid.test(c)),
  );

  // …and the board says WHICH departure each one was. Not "two chips exist":
  // the whole risk here is the two statuses collapsing into one word or one
  // colour, so this pins that the words differ and the paint differs, on the
  // markup the page actually served.
  const chips = [
    ...page.body.matchAll(/<span data-testid="standings-(\w+)" class="([^"]*)">([^<]*)<\/span>/g),
  ].map((m) => ({ status: m[1] ?? "", cls: m[2] ?? "", label: (m[3] ?? "").trim() }));
  const withdrawn = chips.filter((c) => c.status === "withdrawn");
  const disqualified = chips.filter((c) => c.status === "disqualified");
  check(
    `public board: the withdrawal and the disqualification are told apart — one chip each, different word, different paint (${chips
      .map((c) => `${c.status}:${c.label}`)
      .join(" ")})`,
    chips.length === 2 &&
      withdrawn.length === 1 &&
      disqualified.length === 1 &&
      withdrawn[0].label.length > 0 &&
      withdrawn[0].label !== disqualified[0].label &&
      withdrawn[0].cls !== disqualified[0].cls,
  );
}
