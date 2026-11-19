// B5 owner fix-now (d), RB5-W2 - seed a public league of four whose first entrant (a realistic 43-character name) leaves under half
// played, through the real API, for the desktop spec and the width-project spec both. She plays (and wins) ONE of her three lines, so
// the withdrawal EXPUNGES all three (`policy: "expunge"`); one line between two others is played too, and the other two stay to be
// played. Which lines are hers is read from the lines' own seats, never from the product's schedule.
import { expect, type APIRequestContext } from "@playwright/test";
import { TAG, apiJson } from "../helpers";
import { activeOrgSlug, division, publicCompetition } from "../spectator-w2-kit";

export const LONG_LEAVER = "Riverside Rovers Community Football Club 2s";

export interface ExpungedLeaver {
  orgSlug: string;
  compSlug: string;
  divSlug: string;
  divisionId: string;
  /** The three lines the withdrawal removed (hers), the one other played line, and the two still to be played. */
  removed: string[];
  /** Her three lines' `fixture_no`s - the organiser's run sheet keys its rows on them (`li[data-fixture-no]`). */
  removedNos: number[];
  played: string;
  open: string[];
  leaverName: string;
}

export async function seedExpungedLeaver(request: APIRequestContext, label: string): Promise<ExpungedLeaver> {
  expect(LONG_LEAVER.length, "premise: the realistic 43 characters").toBe(43);
  const org = await activeOrgSlug(request);
  const comp = await publicCompetition(request, { name: `${label} ${TAG}`, orgId: org.id });
  const div = await division(request, comp.id, {
    name: "Open",
    sport_key: "generic",
    variant_key: "score",
    config: { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const names = [`${LONG_LEAVER} ${TAG}`, `Ann Lee ${TAG}`, `Bo Chen ${TAG}`, `Cy Diaz ${TAG}`];
  const added = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${div.id}/entrants`, "POST",
    names.map((display_name, i) => ({ kind: "individual", display_name, seed: i + 1 })));
  expect(added.status, JSON.stringify(added.error)).toBe(201);
  const leaver = added.data![0]!.id;
  const stages = await apiJson<{ id: string }[]>(request, `/api/v1/divisions/${div.id}/stages`, "PUT", [
    { seq: 1, kind: "league", name: "League", config: { legs: 1 }, progression: null },
  ]);
  expect(stages.status, JSON.stringify(stages.error)).toBe(200);
  const stageId = stages.data![0]!.id;
  expect((await apiJson(request, `/api/v1/stages/${stageId}/generate`, "POST")).status).toBe(200);
  expect((await apiJson(request, `/api/v1/divisions/${div.id}/start`, "POST")).status).toBe(200);
  const fx = await apiJson<{ id: string; fixture_no: number; stage_id: string; home_entrant_id: string; away_entrant_id: string }[]>(request, `/api/v1/divisions/${div.id}/fixtures`);
  const lines = (fx.data ?? []).filter((f) => f.stage_id === stageId);
  expect(lines.length, "a league of four draws six lines").toBe(6);
  const isHers = (f: (typeof lines)[number]) => f.home_entrant_id === leaver || f.away_entrant_id === leaver;
  const hers = lines.filter(isHers);
  const others = lines.filter((f) => !isHers(f));
  expect(hers.length, "premise: she has three lines").toBe(3);
  // she wins her first line; one other line is played (home wins)
  for (const [f, homeWins] of [[hers[0]!, hers[0]!.home_entrant_id === leaver], [others[0]!, true]] as const) {
    let seq = 0;
    for (const [type, payload] of [["core.start", {}], ["generic.result", homeWins ? { p1Score: 3, p2Score: 0 } : { p1Score: 0, p2Score: 3 }]] as const) {
      const ev = await apiJson<{ seq: number }>(request, `/api/v1/fixtures/${f.id}/events`, "POST", { expected_seq: seq, type, payload });
      expect(ev.status, `${type}: ${JSON.stringify(ev.error)}`).toBe(201);
      seq = ev.data!.seq;
    }
  }
  const out = await apiJson<{ policy: string }>(request, `/api/v1/entrants/${leaver}/withdraw`, "POST");
  expect(out.status, JSON.stringify(out.error)).toBe(200);
  expect(out.data?.policy, "1 of 3 played: under half, her lines are expunged (RB5-W2)").toBe("expunge");
  return {
    orgSlug: org.slug,
    compSlug: comp.slug,
    divSlug: div.slug,
    divisionId: div.id,
    removed: hers.map((f) => f.id),
    removedNos: hers.map((f) => f.fixture_no),
    played: others[0]!.id,
    open: others.slice(1).map((f) => f.id),
    leaverName: names[0]!,
  };
}
