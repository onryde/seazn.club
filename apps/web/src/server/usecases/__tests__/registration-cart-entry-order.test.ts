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
import { createDivision } from "../divisions";
import { groupById, putRegistrationSettings } from "../registrations";
import { buildCartMail } from "../registrations/mail";
import { submitRegistrationGroup } from "../registration-submit";
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
