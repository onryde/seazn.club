// One live draft per address, and a short reference that survives a resubmit (/start "Sent stepper" wave T1, owner-approved
// 2026-11-14). The defect it closes: every POST /api/funnel/start wrote a NEW draft beside the old one, so an organiser who went
// back and sent the wizard again held two live links — and claiming both built two competitions in one organisation.
//
// The rules, as the brief states them (never read off the code):
//   - a reference is `SZ-` and six symbols from the digits and capitals less 0, O, 1 and I (owner change: six, not four);
//   - a start for an address that has an unused, unexpired draft (case-insensitive) replaces it, and the new draft carries the
//     SAME reference; the replaced draft's link no longer claims, and the claim can tell it was replaced (and by which reference);
//   - a start that names an earlier draft by its reference AND the replace key the start returned for it replaces that draft
//     even when the address differs (the Change-email flow); the reference alone, or a wrong key, replaces nothing.
// Driven through the real writer (createFunnelDraft) and the real consumer (consumeFunnelDraft) on a real database.
// Sport: not applicable — a draft's address and reference are read before its sport is (one payload throughout).
// Real Postgres required — skipped without DATABASE_URL.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import {
  consumeFunnelDraft,
  createFunnelDraft,
  funnelDraftCard,
  newFunnelReference,
  replacedFunnelDraftReference,
  type FunnelPayload,
} from "@/lib/funnel";

const HAS_DB = !!process.env.DATABASE_URL;
const RUN = `fdr-${randomUUID().slice(0, 8)}`;
const PAYLOAD: FunnelPayload = { name: `${RUN} Spring Smash`, sport: "Badminton", entrants: 8, format: "league" };

/** The reference alphabet from the owner's rule: 0-9 and A-Z, less 0, O, 1 and I. */
const RULE_ALPHABET = [..."0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"].filter((c) => !"0O1I".includes(c));
const RULE_SHAPE = new RegExp(`^SZ-[${RULE_ALPHABET.join("")}]{6}$`);

const address = (): string => `${RUN}-${randomUUID().slice(0, 8)}@example.com`;

type Row = { id: string; email: string; reference: string; used_at: Date | null; replaced_at: Date | null };
const rowsOf = (email: string) =>
  sql<Row[]>`select id, email, reference, used_at, replaced_at from funnel_drafts where lower(email) = lower(${email}) order by created_at, id`;
/** The drafts that can still claim for an address: unused, not replaced, unexpired. */
const liveOf = async (email: string): Promise<Row[]> =>
  (await sql<(Row & { live: boolean })[]>`
    select id, email, reference, used_at, replaced_at, (used_at is null and replaced_at is null and expires_at > now()) as live
      from funnel_drafts where lower(email) = lower(${email}) order by created_at, id`).filter((r) => r.live);

afterAll(async () => {
  if (!HAS_DB) return;
  await sql`delete from funnel_drafts where email ilike ${`${RUN}-%`}`;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const client = g._sql;
  g._sql = undefined;
  await client?.end();
});

describe("the draft reference (pure)", () => {
  it("is SZ- and six symbols of the owner's alphabet; every symbol is drawn and none outside it", () => {
    expect(RULE_ALPHABET, "premise: 36 symbols less four").toHaveLength(32);
    const seen = new Set<string>();
    let checked = 0;
    for (let i = 0; i < 4000; i++) {
      const ref = newFunnelReference();
      expect(ref, ref).toMatch(RULE_SHAPE);
      for (const c of ref.slice(3)) seen.add(c);
      checked++;
    }
    expect(checked, "anti-vacuity: references were drawn").toBe(4000);
    // 24 000 draws over 32 symbols: a symbol the generator can never reach (a biased or truncated alphabet) shows here.
    expect([...seen].sort(), "every symbol of the alphabet is reachable, nothing else is").toEqual([...RULE_ALPHABET].sort());
  });
});

describe.skipIf(!HAS_DB)("one live draft per address; the reference survives a resubmit (DB)", () => {
  it("a first start writes a draft whose reference is the one it returns, in the owner's shape, with a replace key", async () => {
    const email = address();
    const made = await createFunnelDraft(email, PAYLOAD);
    expect(made.reference).toMatch(RULE_SHAPE);
    expect(made.replaceKey.length, "an opaque key, not a guessable one").toBeGreaterThanOrEqual(32);
    const rows = await rowsOf(email);
    expect(rows.map((r) => [r.id, r.reference])).toEqual([[made.id, made.reference]]);
    // The key is never stored as given.
    const [stored] = await sql<{ hash: string | null }[]>`select replace_key_hash as hash from funnel_drafts where id = ${made.id}`;
    expect(stored!.hash, "stored as a hash").not.toBeNull();
    expect(stored!.hash).not.toContain(made.replaceKey);
  });

  it("the database refuses a reference out of shape — the four excluded symbols, the wrong length, lower case, no prefix", async () => {
    const { id } = await createFunnelDraft(address(), PAYLOAD);
    const bad = ["SZ-ABCDE0", "SZ-ABCDEO", "SZ-ABCDE1", "SZ-ABCDEI", "SZ-ABCD", "SZ-ABCDEFG", "SZ-abcdef", "ABCDEFGH", "SZ-ABCD3"];
    let refused = 0;
    for (const reference of bad) {
      await expect(sql`update funnel_drafts set reference = ${reference} where id = ${id}`, reference).rejects.toMatchObject({
        code: "23514",
        constraint_name: "funnel_drafts_reference_shape",
      });
      refused++;
    }
    expect(refused, "anti-vacuity: every bad shape was tried").toBe(bad.length);
    // The pair: one in shape is taken.
    await sql`update funnel_drafts set reference = 'SZ-23HJKZ' where id = ${id}`;
  });

  it("resubmitting the same address (any case): one live draft, the same reference, and the old link refused as REPLACED", async () => {
    const email = address();
    const first = await createFunnelDraft(email, PAYLOAD);
    const second = await createFunnelDraft(email.toUpperCase(), { ...PAYLOAD, entrants: 12 });
    const third = await createFunnelDraft(email, { ...PAYLOAD, entrants: 16 });

    expect(second.reference, "the second start keeps the reference").toBe(first.reference);
    expect(third.reference, "and so does the third").toBe(first.reference);
    const live = await liveOf(email);
    expect(live.map((r) => r.id), "exactly one live draft: the latest").toEqual([third.id]);
    const rows = await rowsOf(email);
    expect(rows.map((r) => r.replaced_at !== null), "the two before it are replaced").toEqual([true, true, false]);
    expect(rows.map((r) => r.used_at), "and none was used").toEqual([null, null, null]);

    let refused = 0;
    for (const old of [first, second]) {
      expect(await consumeFunnelDraft(old.token), "a replaced link does not claim").toBeNull();
      expect(await replacedFunnelDraftReference(old.token), "the claim can tell it was replaced, and by which reference").toBe(first.reference);
      refused++;
    }
    expect(refused).toBe(2);
    // The pair: the latest link still claims, carrying what was resubmitted.
    const claimed = await consumeFunnelDraft(third.token);
    expect(claimed?.payload.entrants).toBe(16);
    expect(await replacedFunnelDraftReference(third.token), "a claimed (not replaced) link is not reported replaced").toBeNull();
  });

  it("after the claim, a new start for the same address is a new event: a fresh reference, the used draft untouched", async () => {
    const email = address();
    const first = await createFunnelDraft(email, PAYLOAD);
    expect(await consumeFunnelDraft(first.token)).not.toBeNull();
    const next = await createFunnelDraft(email, PAYLOAD);
    expect(next.reference, "not a resubmit of a claimed draft").not.toBe(first.reference);
    const rows = await rowsOf(email);
    expect(rows.map((r) => [r.id, r.used_at !== null, r.replaced_at !== null])).toEqual([
      [first.id, true, false],
      [next.id, false, false],
    ]);
  });

  it("an expired draft is not replaced: the next start gets a fresh reference and the expired one stays as it was", async () => {
    const email = address();
    const first = await createFunnelDraft(email, PAYLOAD);
    await sql`update funnel_drafts set expires_at = now() - interval '1 minute' where id = ${first.id}`;
    const next = await createFunnelDraft(email, PAYLOAD);
    expect(next.reference).not.toBe(first.reference);
    const [old] = await sql<{ replaced_at: Date | null }[]>`select replaced_at from funnel_drafts where id = ${first.id}`;
    expect(old!.replaced_at, "an expired draft is left alone").toBeNull();
    expect(await replacedFunnelDraftReference(first.token)).toBeNull();
  });

  it("Change email: the earlier draft's reference AND its replace key replace it, across addresses, and the reference carries", async () => {
    const before = address();
    const after = address();
    const first = await createFunnelDraft(before, PAYLOAD);
    const second = await createFunnelDraft(after, PAYLOAD, sql, null, { reference: first.reference, replaceKey: first.replaceKey });
    expect(second.reference).toBe(first.reference);
    expect(await liveOf(before), "the old address holds no live draft").toEqual([]);
    expect((await liveOf(after)).map((r) => r.id)).toEqual([second.id]);
    expect(await consumeFunnelDraft(first.token)).toBeNull();
    expect(await replacedFunnelDraftReference(first.token)).toBe(first.reference);

    // A second change: the key is the one the LATEST start returned; the first key retired with its draft.
    const third = address();
    const stale = await createFunnelDraft(third, PAYLOAD, sql, null, { reference: first.reference, replaceKey: first.replaceKey });
    expect(stale.reference, "the first key no longer replaces anything").not.toBe(first.reference);
    expect((await liveOf(after)).map((r) => r.id), "the second draft is untouched").toEqual([second.id]);
    const fourth = address();
    const moved = await createFunnelDraft(fourth, PAYLOAD, sql, null, { reference: second.reference, replaceKey: second.replaceKey });
    expect(moved.reference).toBe(first.reference);
    expect(await liveOf(after)).toEqual([]);
  });

  it("a stranger cannot cancel a draft: the reference with a wrong key, or the right key with another reference, replaces nothing", async () => {
    const victim = address();
    const target = await createFunnelDraft(victim, PAYLOAD);
    const other = await createFunnelDraft(address(), PAYLOAD);
    const attempts = [
      { label: "the reference, a made-up key", previous: { reference: target.reference, replaceKey: randomUUID() + randomUUID() } },
      { label: "the reference, someone else's key", previous: { reference: target.reference, replaceKey: other.replaceKey } },
      { label: "the right key, another reference", previous: { reference: other.reference, replaceKey: target.replaceKey } },
    ];
    let checked = 0;
    for (const a of attempts) {
      const made = await createFunnelDraft(address(), PAYLOAD, sql, null, a.previous);
      expect(made.reference, `${a.label}: a fresh reference`).not.toBe(target.reference);
      expect((await liveOf(victim)).map((r) => r.id), `${a.label}: the victim's draft is untouched`).toEqual([target.id]);
      checked++;
    }
    expect(checked, "anti-vacuity").toBe(attempts.length);
    // `other` was named by reference in the last attempt with the wrong key: untouched too.
    expect(await replacedFunnelDraftReference(other.token)).toBeNull();
  });

  it("a replace key names only a LIVE draft: one already claimed is not replaced, and the new start is its own", async () => {
    const email = address();
    const first = await createFunnelDraft(email, PAYLOAD);
    expect(await consumeFunnelDraft(first.token)).not.toBeNull();
    const next = await createFunnelDraft(address(), PAYLOAD, sql, null, { reference: first.reference, replaceKey: first.replaceKey });
    expect(next.reference).not.toBe(first.reference);
    const [old] = await sql<{ used_at: Date | null; replaced_at: Date | null }[]>`select used_at, replaced_at from funnel_drafts where id = ${first.id}`;
    expect(old!.used_at, "still claimed").not.toBeNull();
    expect(old!.replaced_at, "never replaced after its claim").toBeNull();
  });

  it("both at once: a key for one address's draft and a live draft at the new address are both replaced; the key's reference wins", async () => {
    const before = address();
    const after = address();
    const keyed = await createFunnelDraft(before, PAYLOAD);
    const sitting = await createFunnelDraft(after, PAYLOAD);
    expect(sitting.reference, "premise: two different references").not.toBe(keyed.reference);
    const made = await createFunnelDraft(after, PAYLOAD, sql, null, { reference: keyed.reference, replaceKey: keyed.replaceKey });
    expect(made.reference, "the draft the client holds the key to").toBe(keyed.reference);
    expect(await liveOf(before)).toEqual([]);
    expect((await liveOf(after)).map((r) => r.id)).toEqual([made.id]);
    expect(await replacedFunnelDraftReference(sitting.token), "the one sitting at the new address names the reference that replaced it").toBe(
      keyed.reference,
    );
    expect(await replacedFunnelDraftReference(keyed.token)).toBe(keyed.reference);

    // A chain: an address whose drafts were resubmitted (reference X) is replaced, with the key of another address's draft
    // (reference Y). Every replaced draft of X — the older one too — now names Y, the code its latest email carries.
    const chainAt = address();
    const x1 = await createFunnelDraft(chainAt, PAYLOAD);
    const x2 = await createFunnelDraft(chainAt, PAYLOAD);
    expect(x2.reference, "premise: a resubmit kept X").toBe(x1.reference);
    const y = await createFunnelDraft(address(), PAYLOAD);
    const joined = await createFunnelDraft(chainAt, PAYLOAD, sql, null, { reference: y.reference, replaceKey: y.replaceKey });
    expect(joined.reference, "the key's reference wins").toBe(y.reference);
    let chained = 0;
    for (const old of [x1, x2, y]) {
      expect(await replacedFunnelDraftReference(old.token), "every replaced draft names the surviving reference").toBe(y.reference);
      expect((await funnelDraftCard(old.token)).reference).toBe(y.reference);
      chained++;
    }
    expect(chained).toBe(3);
    expect((await liveOf(chainAt)).map((r) => [r.id, r.reference])).toEqual([[joined.id, y.reference]]);
  });

  it("starts at once for one address leave exactly one live draft", async () => {
    // Without a per-address lock, starts that run together each find no live draft and each write one.
    const email = address();
    const made = await Promise.all(Array.from({ length: 6 }, () => createFunnelDraft(email, PAYLOAD)));
    const live = await liveOf(email);
    expect(live, "one live draft").toHaveLength(1);
    expect(new Set(made.map((m) => m.reference)).size, "one reference across them all").toBe(1);
    expect((await rowsOf(email)).length, "anti-vacuity: every start wrote its draft").toBe(made.length);
  });

  it("the claim page's card read carries the draft's reference (live, replaced or claimed) and nothing for an unknown token", async () => {
    const email = address();
    const first = await createFunnelDraft(email, PAYLOAD, sql, "fr");
    const second = await createFunnelDraft(email, PAYLOAD, sql, "fr");
    let checked = 0;
    for (const token of [first.token, second.token]) {
      expect((await funnelDraftCard(token)).reference, token === first.token ? "replaced" : "live").toBe(first.reference);
      checked++;
    }
    await consumeFunnelDraft(second.token);
    expect((await funnelDraftCard(second.token)).reference, "claimed").toBe(first.reference);
    expect((await funnelDraftCard(`never-${randomUUID()}`)).reference, "no draft").toBeNull();
    expect(checked).toBe(2);
  });
});
