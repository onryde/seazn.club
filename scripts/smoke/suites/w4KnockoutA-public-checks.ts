// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
//
// W4 app A Task 23 (ST-G26) — the public standings order, over HTTP against a real server.
//
// Written in its own file by lane B6b (the harness, index and main were another lane's) and run by `w4KnockoutASuite`
// since the lane merge (merge-lanes-1), which counts its checks. Call it with no arguments; it signs in its own owner.
import { newSession, call, check, signIn, tag, html, v1, v1data } from "../harness.ts";

/**
 * A division's standings read in stage then pool order on the public /present board.
 *
 * `readPublicDivisionDetail` read the standings view with no ORDER BY, and /present draws one standings slide per
 * snapshot in the order the read hands them over — so a pooled group's tables could come up "Group C, Group A, …"
 * (the plan here walks the snapshot key, whose pool half is a random UUID). Four pools, so a read that is not ordered
 * passes by luck one time in twenty-four, not one in two.
 */
export async function w4KnockoutAPublicStandingsOrderSmoke(): Promise<void> {
  const owner = newSession();
  const who = await signIn(owner, `delivered+w4ao_${tag}@resend.dev`);
  const orgs = (await call(owner, "/api/orgs")) as { id: string; slug: string }[];
  const orgSlug = orgs.find((o) => o.id === who.org_id)?.slug ?? "";

  const comp = await v1(owner, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `W4 Order ${tag}`,
    visibility: "public",
  });
  const compRow = v1data<{ id: string; slug: string; visibility: string }>(comp);
  const div = await v1(owner, `/api/v1/competitions/${compRow.id}/divisions`, "POST", {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divRow = v1data<{ id: string; slug: string }>(div);
  const entrants = await v1(
    owner,
    `/api/v1/divisions/${divRow.id}/entrants`,
    "POST",
    ["Ash", "Birch", "Cedar", "Damson", "Elm", "Fir", "Gum", "Hazel"].map((name, i) => ({
      kind: "team",
      display_name: `${name} ${tag}`,
      seed: i + 1,
      members: [],
    })),
  );
  const POOLS = ["A", "B", "C", "D"];
  const stage = await v1(owner, `/api/v1/divisions/${divRow.id}/stages`, "POST", {
    seq: 1,
    kind: "group",
    name: "Groups",
    config: { pools: { count: POOLS.length } },
  });
  const stageId = v1data<{ id: string }>(stage).id;
  const generated = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
  const started = await v1(owner, `/api/v1/divisions/${divRow.id}/start`, "POST");
  check(
    "w4 standings order: a PUBLIC group of four pools is generated and started",
    comp.status === 201 &&
      compRow.visibility === "public" &&
      orgSlug !== "" &&
      div.status === 201 &&
      entrants.status < 300 &&
      stage.status < 300 &&
      generated.status < 300 &&
      started.status < 300,
  );

  // A pool's table is written when its results move: play every match (one per pool of two), so every pool has one.
  const fixtures = v1data<{ id: string }[]>(await v1(owner, `/api/v1/divisions/${divRow.id}/fixtures`)) ?? [];
  const writes: number[] = [];
  for (const f of fixtures) {
    const state = v1data<{ last_seq: number }>(await v1(owner, `/api/v1/fixtures/${f.id}/state`));
    const res = await v1(owner, `/api/v1/fixtures/${f.id}/events`, "POST", {
      expected_seq: state.last_seq,
      type: "generic.result",
      payload: { p1Score: 2, p2Score: 1 },
    });
    writes.push(res.status);
  }
  check(
    `w4 standings order: every pool's match is scored (${writes.length} of ${POOLS.length})`,
    writes.length === POOLS.length && writes.every((w) => w < 300),
  );

  // The board's captions, from the en dictionary's "table.poolLabel" ("Group {key}") under the stage's name. Read off
  // the page as served — its server-rendered slide and its payload alike — in either spelling of the em dash.
  const board = await html(newSession(), `/live/${orgSlug}/${compRow.slug}/${divRow.slug}/present`);
  const at = (key: string) => {
    const spellings = [`Groups — Group ${key}`, `Groups \\u2014 Group ${key}`];
    const hits = spellings.map((s) => board.body.indexOf(s)).filter((i) => i >= 0);
    return hits.length === 0 ? -1 : Math.min(...hits);
  };
  const positions = POOLS.map(at);
  check(
    `w4 standings order: /present lists every pool's table (${positions.filter((p) => p >= 0).length}/${POOLS.length} found)`,
    board.status === 200 && positions.every((p) => p >= 0),
  );
  check(
    "w4 standings order: /present reads the pools in order, Group A first (ST-G26)",
    positions.every((p, i) => i === 0 || (p >= 0 && positions[i - 1] >= 0 && positions[i - 1] < p)),
  );
}
