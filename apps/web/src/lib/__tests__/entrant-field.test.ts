// F10 (2026-09-21) — `inTheField` is the single TypeScript-side answer to
// "is this entrant still competing", now that V412 has widened
// `public_entrants_v` to publish departed entrants so their NAMES resolve on
// results surfaces.
//
// The risk this file exists for is the quiet one. `inTheField` is an
// allow-list, so ANY status it has never heard of falls through to "departed".
// That is the right default for a typo, and the wrong one for a status the
// product later adds on purpose (a 'reserve', a 'pending') — such an entrant
// would silently vanish from the entrants tab, the entrant count, the hub's
// team cards and the public API's entrant list, with nothing red anywhere.
//
// So the table below is checked against the LIVE `entrants.status` check
// constraint: a status added to the vocabulary reds this file, which is the
// moment to decide which side of the line it belongs on. Same shape, and the
// same reasoning, as the fixtures.status coverage test in
// `server/usecases/__tests__/stage-roster-drift.test.ts`.
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { FIELD_ENTRANT_STATUSES, inTheField } from "../entrant-field";

const HAS_DB = !!process.env.DATABASE_URL;

/** Every status the live check constraint allows, and whether an entrant
 *  carrying it is still part of the competing field. Pinned here and
 *  cross-checked against the constraint below, rather than derived from
 *  `FIELD_ENTRANT_STATUSES` — deriving the expectation from the thing under
 *  test would make every row a tautology. */
const IN_FIELD_BY_STATUS = [
  ["registered", true],
  ["confirmed", true],
  ["withdrawn", false],
  ["disqualified", false],
] as const satisfies ReadonlyArray<readonly [string, boolean]>;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

describe("inTheField", () => {
  it.each(IN_FIELD_BY_STATUS)("an entrant with status '%s' is in the field: %s", (status, expected) => {
    expect(inTheField({ status })).toBe(expected);
  });

  it("FIELD_ENTRANT_STATUSES is exactly the statuses that answer true", () => {
    expect([...FIELD_ENTRANT_STATUSES].toSorted()).toEqual(
      IN_FIELD_BY_STATUS.filter(([, yes]) => yes).map(([s]) => s).toSorted(),
    );
    // The negative pair for the line above: the list is not merely non-empty.
    for (const [status, yes] of IN_FIELD_BY_STATUS) {
      expect(FIELD_ENTRANT_STATUSES.includes(status)).toBe(yes);
    }
  });

  it("a status this build has never heard of is DEPARTED, never in the field", () => {
    // The fail-closed default, stated on purpose: a garbage value must not be
    // able to seat somebody in the field. The DB test below is what keeps this
    // default from silently swallowing a real, newly-added status.
    expect(inTheField({ status: "reserve" })).toBe(false);
    expect(inTheField({ status: "" })).toBe(false);
    expect(inTheField({ status: "REGISTERED" })).toBe(false);
  });
});

describe.skipIf(!HAS_DB)("inTheField — against the live entrants.status vocabulary", () => {
  it("the table above covers the WHOLE constraint: no status is classified by default", async () => {
    const [row] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(c.oid) as def
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      where t.relname = 'entrants' and c.contype = 'c'
        and pg_get_constraintdef(c.oid) like '%status = ANY%'`;
    expect(row?.def).toBeTruthy();
    const vocabulary = [...row!.def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!);
    // A one-element parse is a broken regex, not a vocabulary.
    expect(vocabulary.length).toBeGreaterThan(1);
    expect(vocabulary.toSorted()).toEqual(IN_FIELD_BY_STATUS.map(([s]) => s).toSorted());

    // And the partition the constraint implies, read back through the real
    // function: both sides non-empty, so neither arm is vacuous.
    const field = vocabulary.filter((s) => inTheField({ status: s }));
    const departed = vocabulary.filter((s) => !inTheField({ status: s }));
    expect(field.toSorted()).toEqual(["confirmed", "registered"]);
    expect(departed.toSorted()).toEqual(["disqualified", "withdrawn"]);
  });
});
