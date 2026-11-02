// Match Day C7: the org home names a competition's sports from its DIVISIONS (owner ruling 2026-11-01: one named, two named,
// three or more as "N sports"). `listCompetitionCardStats` hands the page the list; this pins what is in it and its order:
//  - every live division's sport, once each — two badminton divisions are one sport;
//  - an archived division is gone from the competition (as everywhere else on the card), so its sport is too;
//  - most divisions first, then by key, so the sport named first is the one most of the competition plays;
//  - the empty case: a competition with no division has no sports (an empty list, never null — the page reads `.length`).
//
// Real Postgres required; skipped without DATABASE_URL (CI runs them).
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createCompetition } from "../competitions";
import { createDivision } from "../divisions";
import { listCompetitionCardStats } from "../card-stats";
import { seedOrg } from "./_seed";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

/** A system variant per sport (the catalog `sync:sports` seeds): what a division is created with. */
const VARIANT: Record<string, string> = { badminton: "bwf", tennis: "tour", cricket: "t20", football: "11-a-side" };

async function comp(auth: AuthCtx, label: string, sports: string[]): Promise<{ id: string; divisions: string[] }> {
  const c = await createCompetition(auth, {
    ends_on: "2030-12-31",
    name: `${label} ${randomUUID().slice(0, 6)}`,
    visibility: "private",
    branding: {},
  });
  const divisions: string[] = [];
  for (const [i, sport] of sports.entries()) {
    const d = await createDivision(auth, c.id, { name: `${sport} ${i}`, sport_key: sport, variant_key: VARIANT[sport]!, config: {} });
    divisions.push(d.id);
  }
  return { id: c.id, divisions };
}

describe.skipIf(!HAS_DB)("listCompetitionCardStats — the sports a competition's divisions play", () => {
  it("lists each live division's sport once, most divisions first then by key; an archived division's sport is gone; none is []", async () => {
    const { auth } = await seedOrg("pro");
    const none = await comp(auth, "No Divisions", []);
    // tennis ×1, badminton ×2, football ×1 (archived below): badminton leads on count; football leaves with its division.
    const mixed = await comp(auth, "Mixed", ["tennis", "badminton", "badminton", "football"]);
    await sql`update divisions set archived_at = now() where id = ${mixed.divisions[3]!}`;
    // A tie on count is broken by key, so the order is stable whichever division was created first.
    const tie = await comp(auth, "Tie", ["tennis", "cricket", "badminton"]);

    const stats = await listCompetitionCardStats(auth);
    const want: [string, string[]][] = [
      [none.id, []],
      [mixed.id, ["badminton", "tennis"]],
      [tie.id, ["badminton", "cricket", "tennis"]],
    ];
    let checked = 0;
    for (const [id, sports] of want) {
      expect(stats.get(id)?.sports, id).toEqual(sports);
      checked++;
    }
    expect(checked).toBe(3);
    expect(stats.get(mixed.id)?.divisions, "premise: the archived division is not counted either").toBe(3);
  });
});
