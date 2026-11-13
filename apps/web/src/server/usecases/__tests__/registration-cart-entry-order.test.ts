// Polish wave J: a cart's entries read in the order the person added them, on every surface that lists them. The register steps
// and the review list the cart in its own order; the status page and the cart confirmation mail read the rows back
// `order by r.created_at, r.id`. Every entry of one cart is inserted in ONE transaction, so with a `now()` default they all
// shared one created_at and the tie fell to the random row id: the sign-off's cart mail listed "Open Singles" before
// "Masters Singles", the order the person did not choose. Each entry now carries its own insert moment, so the read order
// is the submit order on both surfaces.
//
// A two-entry cart would pass a random tie-break half the time, so each cart here has four entries (1 in 24 by luck) and the
// same divisions are submitted again in the reverse order (1 in 576 for both).
//
// Sport: not applicable. The order is the cart's, not the sport's; one generic division per entry.
//
// Real Postgres required; skipped without DATABASE_URL (matches every sibling usecase suite in this directory).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { entryReference } from "@/lib/ref-code";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createDivision, deleteDivision } from "../divisions";
import { groupById, putRegistrationSettings, withdrawRegistrationPublic } from "../registrations";
import { buildCartMail } from "../registrations/mail";
import { submitRegistrationGroup, type SubmitGroupResult } from "../registration-submit";
import { SETTINGS_BASE, asOwner, rig, seedOrg } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

describe.skipIf(!HAS_DB)("a cart's entries keep the order they were added in (polish wave J)", () => {
  it("the status page and the cart mail list the entries in submit order, forwards and reversed", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition, division: first } = await rig(owner);
    // Two individual and two team divisions, interleaved: the two kinds are inserted by different statements (a team mints a join
    // code under a savepoint), and both must carry the order.
    const divisions: { id: string; name: string; kind: "individual" | "team" }[] = [{ id: first.id, name: first.name, kind: "individual" }];
    for (const [name, kind] of [["Masters Teams", "team"], ["Veterans Singles", "individual"], ["Juniors Teams", "team"]] as const) {
      const d = await createDivision(owner, competition.id, {
        name,
        sport_key: "generic",
        variant_key: "score",
        config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
      });
      divisions.push({ id: d.id, name: d.name, kind });
    }
    for (const d of divisions) {
      await putRegistrationSettings(owner, d.id, { ...SETTINGS_BASE, entrant_kind: d.kind, payment_method: "offline", fee_cents: 0 });
    }

    let carts = 0;
    for (const order of [divisions, [...divisions].reverse()]) {
      const res = await submitRegistrationGroup(
        { orgSlug, compSlug: competition.slug },
        {
          contact: { name: "Rae Rep", email: `rep-${randomUUID().slice(0, 8)}@test.local` },
          privacy_consent: true,
          entries: order.map((d, i) =>
            d.kind === "team"
              ? { division_id: d.id, entrant_kind: "team" as const, team_name: `Team ${i + 1}`, players: [{ full_name: `Captain ${i + 1}` }], answers: {} }
              : { division_id: d.id, entrant_kind: "individual" as const, players: [{ full_name: `Player ${i + 1}` }], answers: {} },
          ),
        },
      );
      const expected = order.map((d) => d.name);
      expect(res.entries.map((e) => e.division_id), "premise: the submit answers in cart order").toEqual(order.map((d) => d.id));

      const status = await groupById(res.group_id, res.access_token);
      expect(status.entries.map((e) => e.division_name), "status page").toEqual(expected);

      const mail = await buildCartMail(res.group_id, "https://test.local", res.access_token);
      expect(mail, "the cart mail builds").not.toBeNull();
      expect(mail!.args.entries.map((e) => e.divisionName), "cart mail").toEqual(expected);
      carts += 1;
    }
    expect(carts, "anti-vacuity: forwards and reversed").toBe(2);
    expect(divisions.map((d) => d.kind), "anti-vacuity: four entries per cart, both insert paths").toEqual(["individual", "team", "individual", "team"]);
  });
});

// B5 T17 (spec §6.1, orchestrator rulings 2026-11-13): every entry keeps its place in the cart it was sent in, and its
// reference never changes after submit — an offline transfer quotes it. The rule under test: an entry's `cart_position` is
// its 1-based place in the cart AS SENT (the `entries` array), and the cart's `cart_size` is how many entries it was sent
// with, whatever happens to them afterwards. The database numbers each insert (V519 trigger); submit inserts in cart order,
// so these tests pin that order too — reverse submit's insert loop and the first test reds.
//
// Sport: not applicable — the position is the cart's, not the sport's; one generic division per entry.
type CartRow = { id: string; division_id: string; status: string; cart_position: number; cart_size: number; ref_code: string };

async function cartRows(groupId: string): Promise<CartRow[]> {
  return sql<CartRow[]>`
    select r.id, r.division_id, r.status, r.cart_position, g.cart_size, g.ref_code
    from registrations r join registration_groups g on g.id = r.group_id
    where r.group_id = ${groupId}
    order by r.cart_position`;
}

const refOf = (r: CartRow) => entryReference(r.ref_code, r.cart_position, r.cart_size);

async function genericDivisions(owner: AuthCtx, competitionId: string, specs: ReadonlyArray<{ name: string; kind: "individual" | "team"; capacity?: number }>) {
  const out: { id: string; kind: "individual" | "team" }[] = [];
  for (const s of specs) {
    const d = await createDivision(owner, competitionId, {
      name: s.name,
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    });
    await putRegistrationSettings(owner, d.id, {
      ...SETTINGS_BASE,
      entrant_kind: s.kind,
      capacity: s.capacity ?? null,
      payment_method: "offline",
      fee_cents: 0,
    });
    out.push({ id: d.id, kind: s.kind });
  }
  return out;
}

async function submitCart(
  orgSlug: string,
  compSlug: string,
  divisions: ReadonlyArray<{ id: string; kind: "individual" | "team" }>,
  email = `pos-${randomUUID().slice(0, 8)}@test.local`,
): Promise<SubmitGroupResult> {
  return submitRegistrationGroup(
    { orgSlug, compSlug },
    {
      contact: { name: "Pat Position", email },
      privacy_consent: true,
      entries: divisions.map((d, i) =>
        d.kind === "team"
          ? { division_id: d.id, entrant_kind: "team" as const, team_name: `Team ${i + 1}`, players: [{ full_name: `Captain ${i + 1}` }], answers: {} }
          : { division_id: d.id, entrant_kind: "individual" as const, players: [{ full_name: `Player ${i + 1} ${randomUUID().slice(0, 4)}` }], answers: {} },
      ),
    },
  );
}

async function closeRegistration(owner: AuthCtx, divisionId: string, kind: "individual" | "team") {
  await putRegistrationSettings(owner, divisionId, { ...SETTINGS_BASE, enabled: false, entrant_kind: kind, payment_method: "offline", fee_cents: 0 });
}

describe.skipIf(!HAS_DB)("each entry keeps its place in its cart (B5 T17, cart_position)", () => {
  it("submit stamps cart_position 1..N in cart order, forwards and reversed", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    // Both insert statements (individual, and team under a join-code savepoint), interleaved.
    const divisions = await genericDivisions(owner, competition.id, [
      { name: "Open Singles", kind: "individual" },
      { name: "Masters Teams", kind: "team" },
      { name: "Veterans Singles", kind: "individual" },
      { name: "Juniors Teams", kind: "team" },
    ]);
    let checked = 0;
    for (const order of [divisions, [...divisions].reverse()]) {
      const res = await submitCart(orgSlug, competition.slug, order);
      const rows = await cartRows(res.group_id);
      expect(rows.map((r) => r.division_id), "position i+1 holds the i-th entry sent").toEqual(order.map((d) => d.id));
      expect(rows.map((r) => r.cart_position)).toEqual([1, 2, 3, 4]);
      for (const r of rows) {
        expect(r.cart_size, "the cart was sent with four entries").toBe(4);
        expect(refOf(r)).toBe(`${res.ref_code}-${r.cart_position}`);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: two carts of four").toBe(8);
  });

  it("a one-entry cart is position 1 of 1, quoted bare, and stays bare after its withdrawal", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    const [only] = await genericDivisions(owner, competition.id, [{ name: "Solo Singles", kind: "individual" }]);
    const res = await submitCart(orgSlug, competition.slug, [only!]);
    const [before] = await cartRows(res.group_id);
    expect(before).toMatchObject({ cart_position: 1, cart_size: 1 });
    expect(refOf(before!)).toBe(res.ref_code);

    await withdrawRegistrationPublic(before!.id, res.access_token);
    const after = await cartRows(res.group_id);
    expect(after.map((r) => r.status), "premise: the withdrawal landed").toEqual(["withdrawn"]);
    expect(after[0]).toMatchObject({ cart_position: 1, cart_size: 1 });
    expect(refOf(after[0]!)).toBe(res.ref_code);
  });

  it("cart_position survives deleting a sibling's division (Review Focus 3), down to a lone survivor", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    const [d1, d2, d3] = await genericDivisions(owner, competition.id, [
      { name: "Div One", kind: "individual" },
      { name: "Div Two", kind: "individual" },
      { name: "Div Three", kind: "individual" },
    ]);
    const res = await submitCart(orgSlug, competition.slug, [d1!, d2!, d3!]);
    const ref = res.ref_code!;
    expect((await cartRows(res.group_id)).map(refOf)).toEqual([`${ref}-1`, `${ref}-2`, `${ref}-3`]);

    await closeRegistration(owner, d2!.id, "individual");
    await deleteDivision(owner, d2!.id);
    const two = await cartRows(res.group_id);
    expect(two.map((r) => r.division_id), "premise: the cascade took entry 2 only").toEqual([d1!.id, d3!.id]);
    expect(two.map((r) => r.cart_position)).toEqual([1, 3]);
    expect(two.map((r) => r.cart_size)).toEqual([3, 3]);
    expect(two.map(refOf)).toEqual([`${ref}-1`, `${ref}-3`]);

    await closeRegistration(owner, d1!.id, "individual");
    await deleteDivision(owner, d1!.id);
    const lone = await cartRows(res.group_id);
    expect(lone.map((r) => r.division_id), "premise: one entry left").toEqual([d3!.id]);
    expect(lone[0]).toMatchObject({ cart_position: 3, cart_size: 3 });
    expect(refOf(lone[0]!), "a lone survivor keeps the suffix it was quoted with").toBe(`${ref}-3`);
  });

  it("cart_position never changes on withdraw", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    const divisions = await genericDivisions(owner, competition.id, [
      { name: "W One", kind: "individual" },
      { name: "W Two", kind: "team" },
      { name: "W Three", kind: "individual" },
    ]);
    const res = await submitCart(orgSlug, competition.slug, divisions);
    const before = await cartRows(res.group_id);
    const refs = [1, 2, 3].map((n) => `${res.ref_code}-${n}`);
    expect(before.map(refOf)).toEqual(refs);

    let withdrawn = 0;
    for (const victim of [before[1]!, before[0]!]) {
      await withdrawRegistrationPublic(victim.id, res.access_token);
      withdrawn++;
      const now = await cartRows(res.group_id);
      expect(now.map((r) => r.id), "same entries, same order").toEqual(before.map((r) => r.id));
      expect(now.map((r) => r.cart_position)).toEqual([1, 2, 3]);
      expect(now.map((r) => r.cart_size)).toEqual([3, 3, 3]);
      expect(now.map(refOf)).toEqual(refs);
    }
    const final = await cartRows(res.group_id);
    expect(final.map((r) => r.status), "premise: entries 1 and 2 withdrawn, 3 untouched").toEqual(["withdrawn", "withdrawn", before[2]!.status]);
    expect(withdrawn).toBe(2);
  });

  it("a second cart from the same contact starts again at 1 and leaves the first alone", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    const divisions = await genericDivisions(owner, competition.id, [
      { name: "S One", kind: "individual" },
      { name: "S Two", kind: "individual" },
      { name: "S Three", kind: "team" },
    ]);
    const email = `same-${randomUUID().slice(0, 8)}@test.local`;
    const first = await submitCart(orgSlug, competition.slug, [divisions[0]!, divisions[1]!], email);
    const second = await submitCart(orgSlug, competition.slug, [divisions[2]!, divisions[1]!, divisions[0]!], email);
    expect(second.group_id, "premise: a new cart, not an append").not.toBe(first.group_id);

    const a = await cartRows(first.group_id);
    const b = await cartRows(second.group_id);
    expect(a.map((r) => [r.division_id, r.cart_position, r.cart_size])).toEqual([
      [divisions[0]!.id, 1, 2],
      [divisions[1]!.id, 2, 2],
    ]);
    expect(b.map((r) => [r.division_id, r.cart_position, r.cart_size])).toEqual([
      [divisions[2]!.id, 1, 3],
      [divisions[1]!.id, 2, 3],
      [divisions[0]!.id, 3, 3],
    ]);
    expect(b.map(refOf)).toEqual([1, 2, 3].map((n) => `${second.ref_code}-${n}`));
  });

  it("a waitlisted entry is numbered like any other, in cart order", async () => {
    const { orgId, orgSlug, ownerId } = await seedOrg("pro");
    const owner = asOwner(orgId, ownerId);
    const { competition } = await rig(owner);
    const [full, open] = await genericDivisions(owner, competition.id, [
      { name: "One Place", kind: "individual", capacity: 1 },
      { name: "Plenty", kind: "individual" },
    ]);
    // Two entries into the one-place division: the first takes the place, the second waits.
    const res = await submitCart(orgSlug, competition.slug, [full!, open!, full!]);
    const rows = await cartRows(res.group_id);
    expect(rows.map((r) => r.division_id)).toEqual([full!.id, open!.id, full!.id]);
    expect(rows.map((r) => r.status === "waitlisted"), "premise: only the third entry waits").toEqual([false, false, true]);
    expect(rows.map((r) => r.cart_position)).toEqual([1, 2, 3]);
    expect(rows.map(refOf)).toEqual([1, 2, 3].map((n) => `${res.ref_code}-${n}`));
  });
});
