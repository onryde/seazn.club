// Polish wave P6: the cart confirmation carries an "Invite your teammates" block (labelled per person in waves I and K: one link per
// teammate still to join, named, and for a team the general link, the same set the status page's block offers). The template half is in
// lib/email-templates/__tests__/registration-invite-copy.test.ts; this file drives the REAL producer (`buildCartMail`, which reads the
// entries, their join codes, their kind and their pending teammate slots from the database) and renders its own output, so a producer
// that stopped passing the links - the seam going inert - fails here although the template is green.
//
// The links are bearer capabilities (whoever holds a join code can join the entry), so they ride only a mail that carries the cart
// token, exactly like the Pay button: the organiser's resend and the dispute evidence build the cart with no token and carry none.
//
// Sport: not applicable. The block depends on the entry's kind (team / pair / individual), its status and its roster, not on the sport.
//
// Real Postgres required; skipped without DATABASE_URL (matches every sibling usecase suite in this directory).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import { registrationEmail } from "@/lib/email";
import { createDivision } from "../divisions";
import { putRegistrationSettings } from "../registrations";
import { buildCartMail } from "../registrations/mail";
import { SETTINGS_BASE, seedRegistration, seedSecondEntry, stripeRig, type StripeRigResult } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;
const ORIGIN = "https://test.local";

type Kind = "team" | "pair" | "individual";

async function divisionOf(r: StripeRigResult, name: string, kind: Kind): Promise<string> {
  const division = await createDivision(r.owner, r.competition.id, {
    name,
    sport_key: "generic",
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  await putRegistrationSettings(r.owner, division.id, { ...SETTINGS_BASE, payment_method: "stripe", fee_cents: 500 });
  await sql`update registration_settings set entrant_kind = ${kind} where division_id = ${division.id}`;
  return division.id;
}

const code = () => "JC" + randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase();

async function slot(regId: string, name: string, consent: "pending" | "granted"): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`
    insert into registration_players (registration_id, full_name, source, consent_status)
    values (${regId}, ${name}, 'captain_entered', ${consent}) returning id`;
  return id;
}

interface Cart {
  groupId: string;
  token: string;
  org: string;
  comp: string;
  teamA: { id: string; code: string; danaId: string };
  pairB: { id: string; code: string; slotId: string };
  pairC: { id: string; code: string; divisionId: string; annId: string; beaId: string };
  pairD: { id: string };
  teamE: { id: string };
  teamG: { id: string };
  individualF: { id: string };
}

/** One cart holding every shape the block must tell apart. */
async function cart(): Promise<Cart> {
  const r = await stripeRig({ feeCents: 500 });
  const [{ slug: comp }] = await sql<{ slug: string }[]>`select slug from competitions where id = ${r.competition.id}`;
  const [{ slug: org }] = await sql<{ slug: string }[]>`select slug from organizations where id = ${r.orgId}`;
  const divA = r.division.id;
  await sql`update registration_settings set entrant_kind = 'team' where division_id = ${divA}`;
  const divB = await divisionOf(r, "Pair B", "pair");
  const divC = await divisionOf(r, "Pair C", "pair");
  const divD = await divisionOf(r, "Pair D", "pair");
  const divE = await divisionOf(r, "Team E", "team");
  const divF = await divisionOf(r, "Singles F", "individual");
  const divG = await divisionOf(r, "Team G", "team");

  const seeded = await seedRegistration(r.competition.id, divA, r.settings, { displayName: "Rovers A" });
  const groupId = seeded.registration.group_id;
  const mk = async (divisionId: string, name: string, status: "pending" | "withdrawn" = "pending") =>
    (await seedSecondEntry(groupId, divisionId, 500, name, status)).id;

  const teamA = { id: seeded.registration.id, code: code(), danaId: "" };
  await sql`update registrations set join_code = ${teamA.code} where id = ${teamA.id}`;
  await slot(teamA.id, "Sam Captain", "granted"); // already in: no link
  teamA.danaId = await slot(teamA.id, "Dana Whitfield", "pending");

  const pairB = { id: await mk(divB, "Maya & Priya"), code: code(), slotId: "" };
  await sql`update registrations set join_code = ${pairB.code} where id = ${pairB.id}`;
  pairB.slotId = await slot(pairB.id, "Priya", "pending");
  await slot(pairB.id, "Maya", "granted"); // the captain herself: already in, so exactly ONE slot is pending

  const pairC = { id: await mk(divC, "Ann & Bea"), code: code(), divisionId: divC, annId: "", beaId: "" };
  await sql`update registrations set join_code = ${pairC.code} where id = ${pairC.id}`;
  pairC.annId = await slot(pairC.id, "Ann Lee", "pending");
  pairC.beaId = await slot(pairC.id, "Bea Moss", "pending"); // two pending: a named link each

  const pairD = { id: await mk(divD, "Cy & Di") };
  await sql`update registrations set join_code = ${code()} where id = ${pairD.id}`;
  await slot(pairD.id, "Cy", "granted");
  await slot(pairD.id, "Di", "granted"); // complete: nobody left to invite

  const teamE = { id: await mk(divE, "Gone FC", "withdrawn") };
  await sql`update registrations set join_code = ${code()} where id = ${teamE.id}`;

  const individualF = { id: await mk(divF, "Solo Sam") }; // an individual entry mints no join code

  const teamG = { id: await mk(divG, "Free Agents") };
  await sql`update registrations set join_code = ${code()}, free_agent = true where id = ${teamG.id}`;

  return { groupId, token: seeded.access_token, org, comp, teamA, pairB, pairC, pairD, teamE, teamG, individualF };
}

const joinUrl = (c: Cart, joinCode: string, playerId?: string) =>
  `${ORIGIN}/live/${c.org}/${c.comp}/register/join?join_code=${joinCode}${playerId ? `&player_id=${playerId}` : ""}`;

describe.skipIf(!HAS_DB)("the cart confirmation's invite block, through its real producer (polish wave P6)", () => {
  it("a team gets a named link per teammate still to join and its general link; a pair its pending partners' links; nothing else gets a block", async () => {
    const c = await cart();
    const mail = await buildCartMail(c.groupId, ORIGIN, c.token);
    expect(mail, "the cart builds").not.toBeNull();
    const invites = mail!.args.invites ?? [];
    // Expected values: the join url shape is the route's own (`/live/<org>/<comp>/register/join?join_code=`), the codes, slot ids and
    // names are what the test seeded - none of it read back from the producer.
    expect(invites.map((i) => [i.displayName, i.kind, i.links])).toEqual([
      [
        "Rovers A",
        "team",
        [
          { name: "Dana Whitfield", url: joinUrl(c, c.teamA.code, c.teamA.danaId) },
          { name: null, url: joinUrl(c, c.teamA.code) },
        ],
      ],
      ["Maya & Priya", "pair", [{ name: "Priya", url: joinUrl(c, c.pairB.code, c.pairB.slotId) }]],
      [
        "Ann & Bea",
        "pair",
        [
          { name: "Ann Lee", url: joinUrl(c, c.pairC.code, c.pairC.annId) },
          { name: "Bea Moss", url: joinUrl(c, c.pairC.code, c.pairC.beaId) },
        ],
      ],
    ]);
    // Anti-vacuity: seven entries were seeded; three are invitable, and the four that are not are each named so a missing block is a
    // decision, not an accident (pair complete, withdrawn, individual, free agent).
    expect(mail!.args.entries).toHaveLength(7);
    for (const gone of ["Cy & Di", "Gone FC", "Solo Sam", "Free Agents"]) {
      expect(invites.some((i) => i.displayName === gone), `${gone} has no invite`).toBe(false);
    }
    expect(invites.flatMap((i) => i.links), "five links in all").toHaveLength(5);
  });

  it("the rendered mail carries every link: a hyperlink on its person's label in html, the label and the url in text", async () => {
    const c = await cart();
    const mail = await buildCartMail(c.groupId, ORIGIN, c.token);
    const content = await registrationEmail(mail!.args, mail!.locale);
    const links: [string, string][] = [
      [joinUrl(c, c.teamA.code, c.teamA.danaId), "Dana Whitfield's link"],
      [joinUrl(c, c.teamA.code), "Link for anyone else"],
      [joinUrl(c, c.pairB.code, c.pairB.slotId), "Priya's link"],
      [joinUrl(c, c.pairC.code, c.pairC.annId), "Ann Lee's link"],
      [joinUrl(c, c.pairC.code, c.pairC.beaId), "Bea Moss's link"],
    ];
    let checked = 0;
    for (const [u, label] of links) {
      expect(content.text, u).toContain(`${label}: ${u}`);
      expect(content.html, u).toContain(`href="${u.replace(/&/g, "&amp;")}"`);
      expect(content.html, `${label} is the link's text`).toMatch(new RegExp(`href="${u.replace(/&/g, "&amp;").replace(/[.?]/g, "\\$&")}"[^>]*>${label}</a>`));
      checked += 1;
    }
    expect(checked).toBe(5);
    // A dead / complete / individual / free-agent entry's code never reaches the mail.
    const dead = await sql<{ join_code: string }[]>`
      select join_code from registrations
      where id in (${c.pairD.id}, ${c.teamE.id}, ${c.teamG.id}) and join_code is not null`;
    expect(dead).toHaveLength(3); // premise: they DO hold a code, so their absence below is the producer's decision
    for (const { join_code } of dead) {
      expect(content.text).not.toContain(join_code);
      expect(content.html).not.toContain(join_code);
    }
  });

  it("a youth division's link is named as the status page names the slot: masked", async () => {
    const c = await cart();
    await sql`update divisions set youth = true where id = ${c.pairC.divisionId}`;
    const invites = (await buildCartMail(c.groupId, ORIGIN, c.token))!.args.invites!;
    const pair = invites.find((i) => i.displayName === "Ann & Bea")!;
    expect(pair.links.map((l) => l.name)).toEqual(["Ann L.", "Bea M."]);
    // The control: the adult team's teammate stays in full.
    expect(invites.find((i) => i.displayName === "Rovers A")!.links[0]!.name).toBe("Dana Whitfield");
  });

  it("no cart token, no join link: the organiser's resend and the dispute evidence carry none", async () => {
    const c = await cart();
    const withToken = await buildCartMail(c.groupId, ORIGIN, c.token);
    const without = await buildCartMail(c.groupId, ORIGIN, null);
    expect(withToken!.args.invites, "premise: the same cart has invites with the token").toHaveLength(3);
    expect(without!.args.invites ?? []).toEqual([]);
    const content = await registrationEmail(without!.args, without!.locale);
    for (const part of [content.html, content.text]) {
      expect(part).not.toContain(c.teamA.code);
      expect(part).not.toContain(c.pairB.code);
      expect(part).not.toContain("join_code");
    }
  });

  it("sequence: a teammate joins, then two more are typed - the links follow the roster, never a stale one", async () => {
    const c = await cart();
    const before = (await buildCartMail(c.groupId, ORIGIN, c.token))!.args.invites!;
    expect(before.find((i) => i.displayName === "Maya & Priya")?.links).toEqual([{ name: "Priya", url: joinUrl(c, c.pairB.code, c.pairB.slotId) }]);

    // Priya joins (her slot's consent is granted): the pair is complete, so its block goes; Dana joins: the team keeps its general link.
    await sql`update registration_players set consent_status = 'granted' where id in (${c.pairB.slotId}, ${c.teamA.danaId})`;
    const claimed = (await buildCartMail(c.groupId, ORIGIN, c.token))!.args.invites!;
    expect(claimed.map((i) => i.displayName)).toEqual(["Rovers A", "Ann & Bea"]);
    expect(claimed[0]!.links).toEqual([{ name: null, url: joinUrl(c, c.teamA.code) }]);

    // Two slots pending again (a captain who typed a different partner as well): a named link each, in roster order.
    const sister = await slot(c.pairB.id, "Priya's sister", "pending");
    const cousin = await slot(c.pairB.id, "Priya's cousin", "pending");
    const retyped = (await buildCartMail(c.groupId, ORIGIN, c.token))!.args.invites!;
    expect(retyped.find((i) => i.displayName === "Maya & Priya")?.links).toEqual([
      { name: "Priya's sister", url: joinUrl(c, c.pairB.code, sister) },
      { name: "Priya's cousin", url: joinUrl(c, c.pairB.code, cousin) },
    ]);

    // The team entry stops being invitable the moment it is withdrawn.
    await sql`update registrations set status = 'withdrawn' where id = ${c.teamA.id}`;
    const afterWithdraw = (await buildCartMail(c.groupId, ORIGIN, c.token))!.args.invites!;
    expect(afterWithdraw.some((i) => i.displayName === "Rovers A")).toBe(false);
    expect(afterWithdraw.map((i) => i.displayName)).toEqual(["Maya & Priya", "Ann & Bea"]);
  });

  it("an empty case: a cart of one individual entry has no invite and the mail is the mail it always was", async () => {
    const r = await stripeRig({ feeCents: 500 });
    const seeded = await seedRegistration(r.competition.id, r.division.id, r.settings, { displayName: "Solo Sam" });
    const mail = await buildCartMail(seeded.registration.group_id, ORIGIN, seeded.access_token);
    expect(mail!.args.invites ?? []).toEqual([]);
    const content = await registrationEmail(mail!.args, mail!.locale);
    expect(content.text).not.toMatch(/join_code|\/register\/join/);
  });
});
