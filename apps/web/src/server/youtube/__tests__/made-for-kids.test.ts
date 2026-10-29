// YouTube Connect follow-up (owner 2026-10-29; Google YouTube API Services Developer Policies III.E.4.j): a replay of a video MADE FOR
// KIDS is a link out on the public match page, never an embedded player. This file owns the DATA half of that rule - the flag each
// broadcast row carries - and the controller rulings behind it:
//
//   R1  the flag is PER BROADCAST, stamped when Go live makes the row, from the SAME value sent to YouTube (selfDeclaredMadeForKids).
//       The connection's flag is editable later (PATCH), so the connection is never re-read: a later PATCH moves NO existing row.
//       V482 backfills the rows that exist from their connection - the migration's own update statement, read from the file here.
//   R1  and the column is NOT NULL with NO default: a writer that forgets it is refused, not defaulted to "not for kids".
//   R2  YouTube's own determination counts too, but through a call that already exists: the end step's `broadcastLife` read
//       (liveBroadcasts.list part=status) - its `status.madeForKids` is ORed in, so a flag never goes back from true to false.
//
// Expected values are typed from the rulings. The "sent to YouTube" side is read from the FAKE's own record of what it was sent
// (`inspectBroadcast`), not from the row - so a stamp read from anywhere but the call's argument cannot agree with it by construction.
// Real Postgres required; skipped without DATABASE_URL. Sport: not applicable (a broadcast row reads no sport rule).
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sentry", () => ({ captureError: vi.fn() }));

import { sql } from "@/lib/db";
import { divisionRig } from "@/server/usecases/__tests__/_rig";
import { updateConnectionSettings } from "@/server/youtube/connections";
import { FakeYouTube } from "@/server/youtube/fake";
import { prepareYoutubeBroadcast } from "@/server/youtube/prepare";
import { connect, org, type Org } from "./_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;

// ---- KEKs of this file's own (a sealed refresh token and a pooled key); the developer's put back afterwards, never printed ------
const KEKS = ["YOUTUBE_TOKEN_KEK", "RELAY_KEK"] as const;
const savedKeks = Object.fromEntries(KEKS.map((k) => [k, process.env[k]]));
beforeAll(() => { for (const k of KEKS) process.env[k] = randomBytes(32).toString("hex"); });
afterAll(() => {
  for (const k of KEKS) {
    if (savedKeks[k] === undefined) delete process.env[k];
    else process.env[k] = savedKeks[k];
  }
});

interface World { o: Org; orgId: string; connectionId: string; targetId: string; fixtures: string[]; fake: FakeYouTube }
/** An org with a channel connected through the real save, declared `madeForKids` there, and `n` fixtures of one division. */
async function world(madeForKids: boolean, n = 1): Promise<World> {
  const o = await org();
  const c = await connect(o, { madeForKids });
  let entrants = 2;
  while ((entrants * (entrants - 1)) / 2 < n) entrants++;
  const d = await divisionRig(o.auth, { entrants });
  if (d.fixtureIds.length < n) throw new Error(`rig made ${d.fixtureIds.length} fixtures, the test needs ${n}`);
  return { o, orgId: o.orgId, connectionId: c.connectionId, targetId: c.targetId, fixtures: d.fixtureIds.slice(0, n), fake: new FakeYouTube() };
}

/** Go live's prepare step, the real producer of a broadcast row. */
async function goLive(w: World, fixtureId: string): Promise<{ rowId: string; ytId: string; reused: boolean }> {
  const p = await prepareYoutubeBroadcast({ orgId: w.orgId, fixtureId, targetId: w.targetId, now: new Date(), startCause: "organiser" }, w.fake);
  if (p === null) throw new Error("prepare answered null for an API destination");
  const [r] = await sql<{ yt_broadcast_id: string }[]>`select yt_broadcast_id from youtube_broadcasts where id = ${p.broadcastId}`;
  return { rowId: p.broadcastId, ytId: r!.yt_broadcast_id, reused: p.reused };
}
const flagOf = async (rowId: string) =>
  (await sql<{ made_for_kids: boolean }[]>`select made_for_kids from youtube_broadcasts where id = ${rowId}`)[0]!.made_for_kids;
/** What YouTube (the fake) was told when the broadcast was made: the value on the wire, as the fake recorded it. */
const sentOf = (w: World, ytId: string): boolean => {
  const b = w.fake.inspectBroadcast(ytId);
  if (b === null) throw new Error(`the fake holds no broadcast ${ytId}`);
  return b.madeForKids;
};

describe.skipIf(!HAS_DB)("R1: a broadcast row is stamped with the made-for-kids value Go live SENT to YouTube", () => {
  it("EMPTY CASE FIRST: a connection declared made-for-kids and one declared not each stamp their broadcast, and the row equals what was sent", async () => {
    let checked = 0;
    const seen = new Set<boolean>();
    for (const declared of [true, false]) {
      const w = await world(declared);
      const { rowId, ytId } = await goLive(w, w.fixtures[0]!);
      expect(await flagOf(rowId), `row, connection declared ${declared}`).toBe(declared);
      expect(sentOf(w, ytId), `YouTube was sent ${declared}`).toBe(declared);
      seen.add(await flagOf(rowId));
      checked++;
    }
    expect(checked, "anti-vacuity: both declarations were driven").toBe(2);
    expect([...seen].sort(), "the two outcomes differ, so a constant cannot pass").toEqual([false, true]);
  });

  it("a LATER connection PATCH moves no existing broadcast: not the row, not a reuse of it; only the NEXT broadcast follows the new value", async () => {
    const w = await world(true, 3);
    const [f1, f2, f3] = w.fixtures as [string, string, string];
    const first = await goLive(w, f1);
    expect(await flagOf(first.rowId), "premise: stamped true").toBe(true);

    // The organiser corrects the channel to NOT made-for-kids.
    await updateConnectionSettings(w.o.auth, w.orgId, w.connectionId, { madeForKids: false });
    expect(await flagOf(first.rowId), "the PATCH did not rewrite the existing row").toBe(true);
    const again = await goLive(w, f1);
    expect(again.reused, "premise: the same fixture's open broadcast is reused").toBe(true);
    expect(again.rowId).toBe(first.rowId);
    expect(await flagOf(first.rowId), "a reuse keeps the stamp it was made with").toBe(true);
    expect(sentOf(w, first.ytId), "and YouTube still holds what it was told").toBe(true);

    const second = await goLive(w, f2);
    expect(await flagOf(second.rowId), "the next broadcast follows the connection's new value").toBe(false);
    expect(sentOf(w, second.ytId)).toBe(false);

    // And the other direction: false -> true moves no existing row either.
    await updateConnectionSettings(w.o.auth, w.orgId, w.connectionId, { madeForKids: true });
    expect(await flagOf(second.rowId), "false stays false").toBe(false);
    expect(await flagOf(first.rowId), "true stays true").toBe(true);
    const third = await goLive(w, f3);
    expect(await flagOf(third.rowId)).toBe(true);
    expect(sentOf(w, third.ytId)).toBe(true);
  });
});

describe.skipIf(!HAS_DB)("R1: the column is NOT NULL with no default - a writer that forgets the flag is refused", () => {
  it("information_schema: not nullable, no default; and an insert without it, or with an explicit NULL, is refused while one with a value lands", async () => {
    const [col] = await sql<{ is_nullable: string; column_default: string | null }[]>`
      select is_nullable, column_default from information_schema.columns
       where table_schema = current_schema() and table_name = 'youtube_broadcasts' and column_name = 'made_for_kids'`;
    expect(col, "premise: the column exists").toBeDefined();
    expect(col!.is_nullable).toBe("NO");
    expect(col!.column_default, "no default: nothing fills it in for a forgetful writer").toBeNull();

    const w = await world(false, 3);
    const [fa, fb, fc] = w.fixtures as [string, string, string];
    await expect(sql`
      insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state)
      values (${w.orgId}, ${w.connectionId}, ${fa}, 'Match', 'unlisted', 'created')`).rejects.toThrow(/made_for_kids/);
    await expect(sql`
      insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state, made_for_kids)
      values (${w.orgId}, ${w.connectionId}, ${fb}, 'Match', 'unlisted', 'created', null)`).rejects.toThrow(/made_for_kids/);
    await sql`
      insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state, made_for_kids)
      values (${w.orgId}, ${w.connectionId}, ${fc}, 'Match', 'unlisted', 'created', true)`;
    expect((await sql<{ n: number }[]>`select count(*)::int as n from youtube_broadcasts where fixture_id = ${fc}`)[0]!.n, "the twin landed").toBe(1);
  });
});

describe.skipIf(!HAS_DB)("R1: V482's backfill sets every existing row from its connection", () => {
  // The migration's OWN update, read from the file (never retyped), run against a TEMP table that shadows youtube_broadcasts for
  // this transaction only (a temp table is searched first by an unqualified name), with the NOT NULL dropped from the temp copy
  // - the state the real table is in between V482's `add column` and `set not null`. Nothing shared is locked or changed.
  // Read inside each test (not at module scope), so a missing file fails THAT test with its path rather than failing the collection.
  // Found by NAME with the version left open (as w2e-migration.test.ts does), so a renumber after a collision with main cannot strand it.
  const migrationCode = (): string => {
    const dir = resolve(__dirname, "../../../../../../db/migration/deltas");
    const found = readdirSync(dir).filter((f) => /^V\d+__youtube_broadcast_made_for_kids\.sql$/.test(f));
    expect(found, "exactly one delta carries the made-for-kids column").toHaveLength(1);
    return readFileSync(resolve(dir, found[0]!), "utf8").replace(/--.*$/gm, "");
  };

  it("a row of a made-for-kids connection becomes true, a row of a connection that is not becomes false, and nothing is left NULL", async () => {
    const update = /update youtube_broadcasts[\s\S]*?;/.exec(migrationCode())?.[0];
    expect(update, "V482 holds the backfill update").toBeDefined();

    const kids = await world(true);
    const plain = await world(false);
    const ROLLBACK = new Error("rollback");
    let seen: { fixture_id: string; made_for_kids: boolean | null }[] = [];
    let updated = 0;
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("create temp table yb_probe (like youtube_broadcasts including defaults)");
        await tx.unsafe("alter table yb_probe rename to youtube_broadcasts");
        await tx.unsafe("alter table youtube_broadcasts alter column made_for_kids drop not null");
        for (const w of [kids, plain]) {
          await tx`insert into youtube_broadcasts (org_id, connection_id, fixture_id, title, privacy, state, made_for_kids)
                   values (${w.orgId}, ${w.connectionId}, ${w.fixtures[0]!}, 'Match', 'unlisted', 'failed', null)`;
        }
        const res = await tx.unsafe(update!);
        updated = res.count;
        seen = await tx<{ fixture_id: string; made_for_kids: boolean | null }[]>`select fixture_id, made_for_kids from youtube_broadcasts`;
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
    const byFixture = new Map(seen.map((r) => [r.fixture_id, r.made_for_kids]));
    expect(byFixture.size, "both probe rows were read inside the transaction").toBe(2);
    expect(updated, "the statement moved both rows").toBe(2);
    expect(byFixture.get(kids.fixtures[0]!), "a made-for-kids connection's row").toBe(true);
    expect(byFixture.get(plain.fixtures[0]!), "a connection that is not made-for-kids: its row").toBe(false);
    // The temp table is gone with the rollback: the real table never saw the probe rows.
    expect((await sql<{ n: number }[]>`select count(*)::int as n from youtube_broadcasts where title = 'Match' and state = 'failed' and connection_id in (${kids.connectionId}, ${plain.connectionId})`)[0]!.n).toBe(0);
  });

  it("the statement is the file's only data move, and the NOT NULL comes after it (add column, update, set not null - in that order)", () => {
    const code = migrationCode();
    const add = code.indexOf("add column made_for_kids");
    const upd = code.search(/update youtube_broadcasts/);
    const notNull = code.search(/alter column made_for_kids set not null/);
    expect([add, upd, notNull].every((i) => i >= 0), "all three statements are present").toBe(true);
    expect(add).toBeLessThan(upd);
    expect(upd).toBeLessThan(notNull);
    expect(code.match(/\bupdate\s+youtube_broadcasts/g), "exactly one update").toHaveLength(1);
  });
});
