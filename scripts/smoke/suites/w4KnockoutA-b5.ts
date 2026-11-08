// Shared state and helpers (pass/fail counters, check, sessions, the HTTP helpers, tag): see the header of that file.
import { type Session, check, tag, v1, v1data } from "../harness.ts";

/**
 * Format matrix W4 knockout app-A, lane B5 (Task 16) — smoke checks over real HTTP against a live server, as
 * UNWIRED exports: the controller folds them into `w4KnockoutASuite` (and its EXPECTED_CHECKS) at the lane merge. Each
 * returns the number of checks it counted, so the caller can pin its total.
 *
 * T16 (X-SP-6, owner ruling 269; RB4-S6/S7): a stepladder or page playoff with nothing to seed from is refused 422 by name
 * (STEPLADDER_NEEDS_TABLE_SOURCE / PAGE_PLAYOFF_NEEDS_TABLE_SOURCE) and writes nothing; after a league, it is taken.
 */

const TOP_FOUR = { sources: [{ stage: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }] }], placement: "rank_order", timing: "setup" };

/** A fresh generic division of four seeded players on its own competition. */
async function fourPlayerDivision(s: Session, label: string): Promise<{ divId: string | undefined; ids: string[] }> {
  const comp = v1data<{ id: string } | undefined>(
    await v1(s, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `W4a B5 ${label} ${tag}`, visibility: "private" }),
  );
  const divId = v1data<{ id: string } | undefined>(
    await v1(s, `/api/v1/competitions/${comp?.id}/divisions`, "POST", {
      name: label,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  )?.id;
  const added = v1data<{ id: string }[] | undefined>(
    await v1(
      s,
      `/api/v1/divisions/${divId}/entrants`,
      "POST",
      [1, 2, 3, 4].map((n) => ({ kind: "individual", display_name: `${label} P${n} ${tag}`, seed: n })),
    ),
  );
  return { divId, ids: (added ?? []).map((e) => e.id) };
}

/** T16 (X-SP-6): one check per table-only kind — refused 422 by its own code, nothing written, then taken after a league. */
export async function w4KnockoutAB5StandaloneRefusal(owner: Session): Promise<number> {
  let checked = 0;
  for (const [kind, code] of [["stepladder", "STEPLADDER_NEEDS_TABLE_SOURCE"], ["page_playoff", "PAGE_PLAYOFF_NEEDS_TABLE_SOURCE"]] as const) {
    const { divId } = await fourPlayerDivision(owner, `Standalone ${kind}`);
    const refused = await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind, name: "Finals", config: {} });
    const written = (v1data<unknown[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/stages`)) ?? [null]).length;
    const fed = await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", [
      { seq: 1, kind: "league", name: "League", config: { legs: 1 } },
      { seq: 2, kind, name: "Finals", config: {}, progression: TOP_FOUR },
    ]);
    checked++;
    check(
      `w4a T16 X-SP-6: a standalone ${kind} is refused 422 ${code} and writes nothing; after a league it is taken (got ${refused.status} ${refused.json.error?.code ?? "-"}, ${written} stage(s), then ${fed.status})`,
      refused.status === 422 && refused.json.error?.code === code && written === 0 && fed.status === 201,
    );
  }
  return checked;
}
