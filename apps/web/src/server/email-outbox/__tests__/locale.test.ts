// `recipientLocale` (phase 3 wave 1, T7): the language a queued mail is rendered in, decision D4 of
// docs/superpowers/specs/2026-10-25-email-outbox-phase3-design.md:
//
//   the explicit pick, then the linked account's locale (through an existing link only), then the org default, then `en`.
//
// An invalid value at any step falls through to the next one, and a soft-deleted account is not a source (its locale was kept only
// until the deletion; the person asked to be forgotten). Every expected value below is written out from that rule, never read back
// from the function under test. Real Postgres: the account step is a read of `users`.
//
// Sport: not applicable. The language of an email does not vary by sport.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { recipientLocale } from "../locale";

const HAS_DB = !!process.env.DATABASE_URL;

/** Every account this file commits. Removed in `afterAll`, by id and (for the one a rolled-back transaction would have made) by address. */
const RUN = `loc-${randomUUID().slice(0, 8)}`;
const created: string[] = [];

afterAll(async () => {
  if (HAS_DB) {
    await sql`delete from users where id = any(${created}::uuid[]) or email like ${`${RUN}-%`}`;
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
});

/** A user with the given stored locale (null = never chose one), soft-deleted or not. Returns its id. */
async function account(locale: string | null, deleted: boolean): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (email, display_name, email_verified, locale, deleted_at)
    values (${`${RUN}-${randomUUID().slice(0, 12)}@test.local`}, 'Locale probe', true, ${locale}, ${deleted ? new Date() : null})
    returning id`;
  created.push(row!.id);
  return row!.id;
}

type Case = {
  name: string;
  pick: string | null;
  /** The account's stored locale (null = never chose one). */
  acct: string | null;
  deleted: boolean;
  /** false = the call carries NO user id although the account exists: there is no link, so the account is not a source (controller call §2). */
  linked: boolean;
  org: string | null;
  expected: Locale;
};

/** The spec's table (D4), (pick, account locale, account deleted, org default) -> expected. Typed here from the rule. */
const CASES: Case[] = [
  { name: "an explicit pick wins over the account and the org", pick: "es", acct: "fr", deleted: false, linked: true, org: "nl", expected: "es" },
  { name: "no pick: the linked account's locale", pick: null, acct: "fr", deleted: false, linked: true, org: "nl", expected: "fr" },
  { name: "a deleted account is not a source: the org default", pick: null, acct: "fr", deleted: true, linked: true, org: "nl", expected: "nl" },
  { name: "an account that never chose a locale: the org default", pick: null, acct: null, deleted: false, linked: true, org: "nl", expected: "nl" },
  { name: "nothing anywhere: en", pick: null, acct: null, deleted: false, linked: true, org: null, expected: "en" },
  { name: "an invalid pick falls through to the org default", pick: "xx", acct: null, deleted: false, linked: true, org: "fr", expected: "fr" },
  { name: "no link at all: the account step is skipped even though an account (fr) exists, so en", pick: null, acct: "fr", deleted: false, linked: false, org: null, expected: "en" },
];

describe.skipIf(!HAS_DB)("recipientLocale follows D4 (DB)", () => {
  it("the spec's table, one row at a time", async () => {
    let checked = 0;
    for (const c of CASES) {
      // The account exists in every row; the unlinked row differs from a linked one only in the id the call carries.
      const id = await account(c.acct, c.deleted);
      const userId = c.linked ? id : null;
      expect(await recipientLocale(sql, { pick: c.pick, userId, orgDefault: c.org }), c.name).toBe(c.expected);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every row of the table was judged").toBe(CASES.length);
    expect(checked).toBe(7);
  });

  it("the answers are not all one value (so a function that returned a constant would be seen)", () => {
    expect(new Set(CASES.map((c) => c.expected)).size).toBeGreaterThanOrEqual(4);
  });

  it("an invalid pick falls through to the next step, whatever the invalid value is", async () => {
    // Pseudolocales and unknown codes are not supported locales (`hasLocale`): the dev-only `en-XA` is never a pick.
    const bad = ["xx", "en-XA", "", "EN", "fr-FR"];
    let checked = 0;
    for (const v of bad) {
      expect(LOCALES as readonly string[], `premise: ${JSON.stringify(v)} is not a shipped locale`).not.toContain(v);
      const good = await account("fr", false);
      expect(await recipientLocale(sql, { pick: v, userId: good, orgDefault: "nl" }), `pick ${JSON.stringify(v)} -> account`).toBe("fr");
      expect(await recipientLocale(sql, { pick: v, userId: null, orgDefault: "nl" }), `pick ${JSON.stringify(v)} -> org`).toBe("nl");
      // An invalid org default falls through as well: the end of the chain is en.
      expect(await recipientLocale(sql, { pick: v, userId: null, orgDefault: v }), `pick+org ${JSON.stringify(v)} -> en`).toBe("en");
      checked += 3;
    }
    expect(checked, "anti-vacuity").toBe(bad.length * 3);
  });

  it("an invalid ACCOUNT locale falls through too (the database's CHECK keeps one out today, so the read is stubbed to reach the guard)", async () => {
    // users_locale_valid allows only the four shipped locales and null, so a real row cannot hold "xx". The guard is for the day the
    // CHECK is widened (a locale retired from the product while accounts still hold it); a stub of the handle reaches it now.
    const stub = (value: string | null) => (async () => [{ locale: value }]) as unknown as typeof sql;
    let checked = 0;
    for (const v of ["xx", "en-XA", "", "EN"]) {
      expect(await recipientLocale(stub(v), { pick: null, userId: randomUUID(), orgDefault: "nl" }), `account ${JSON.stringify(v)} -> org`).toBe("nl");
      expect(await recipientLocale(stub(v), { pick: null, userId: randomUUID(), orgDefault: null }), `account ${JSON.stringify(v)} -> en`).toBe("en");
      checked += 2;
    }
    // The positive pair: the same stub answering a shipped locale is followed.
    expect(await recipientLocale(stub("es"), { pick: null, userId: randomUUID(), orgDefault: "nl" })).toBe("es");
    expect(checked).toBe(8);
  });

  it("every shipped locale is honoured at every step (a locale list typed into the function would drop one)", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const userId = await account(locale, false);
      expect(await recipientLocale(sql, { pick: locale, userId: null, orgDefault: null }), `pick ${locale}`).toBe(locale);
      expect(await recipientLocale(sql, { pick: null, userId, orgDefault: null }), `account ${locale}`).toBe(locale);
      expect(await recipientLocale(sql, { pick: null, userId: null, orgDefault: locale }), `org ${locale}`).toBe(locale);
      checked += 3;
    }
    expect(checked).toBe(LOCALES.length * 3);
    expect(checked).toBeGreaterThanOrEqual(12);
  });

  it("a user id that names no row falls through (the empty read is not an error and not a value)", async () => {
    const missing = randomUUID();
    expect(await recipientLocale(sql, { pick: null, userId: missing, orgDefault: "es" })).toBe("es");
    expect(await recipientLocale(sql, { pick: null, userId: missing, orgDefault: null })).toBe("en");
  });

  it("the pick, when valid, needs no database read at all: it answers for an id that names nothing", async () => {
    expect(await recipientLocale(sql, { pick: "nl", userId: randomUUID(), orgDefault: "fr" })).toBe("nl");
  });

  it("reads on the handle it is given: a transaction sees an account its own transaction has not committed (#996: no pooled call inside withTenant)", async () => {
    // Rolled back at the end (a sentinel throw), so the account this makes is never committed: the pooled read below could not see it
    // either way, and nothing is left behind.
    class Rollback extends Error {}
    const box: { out?: { inTx: string; pooled: string } } = {};
    await sql
      .begin(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          insert into users (email, display_name, email_verified, locale)
          values (${`${RUN}-tx-${randomUUID().slice(0, 12)}@test.local`}, 'Locale tx probe', true, 'fr') returning id`;
        const inTx = await recipientLocale(tx, { pick: null, userId: row!.id, orgDefault: "nl" });
        // The pool cannot see the uncommitted row, so a pooled read would have answered the org default.
        const pooled = await recipientLocale(sql, { pick: null, userId: row!.id, orgDefault: "nl" });
        box.out = { inTx, pooled };
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
    if (box.out === undefined) throw new Error("the transaction body did not run");
    expect(box.out.inTx).toBe("fr");
    expect(box.out.pooled, "premise: the pool does not see the uncommitted account").toBe("nl");
  });
});
