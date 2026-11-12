// Polish wave P3 (walkthrough W4, W13, W3): the join page told a joiner "YOU'RE IN, your spot is confirmed" while the TEAM's entry was still
// awaiting payment or the organiser's approval. `joinTeamEntry` now answers where the entry stands (`entry_state`), read live under the same
// row lock the join writes under, and the join preview says what KIND of entry the link joins (`entrant_kind`), so the page can say "this
// pair is full" only for a pair.
//
// Expected states are the rulebook's (a fee is owed only while an entry is `pending`; a `paid` entry waits on approval alone; a free
// auto-approved entry has nothing to name), written out per row, never read back from the code under test.
//
// Real Postgres required; skipped without DATABASE_URL (matches every sibling usecase suite in this directory).
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { putRegistrationSettings } from "@/server/usecases/registrations";
import { joinTeamEntry, previewJoinEntry } from "../registration-submit";
import type { RegistrationRow } from "../registrations";
import { asOwner, rig, seedOrg, seedRegistration, SETTINGS_BASE } from "./_registration-fixtures";

const HAS_DB = !!process.env.DATABASE_URL;

async function entry(a: {
  kind?: "team" | "pair";
  fee?: number;
  approval?: "auto" | "manual";
  status?: RegistrationRow["status"];
  players?: string[];
}) {
  const { orgId, ownerId } = await seedOrg("pro");
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  const settings = await putRegistrationSettings(owner, division.id, {
    ...SETTINGS_BASE,
    entrant_kind: a.kind ?? "team",
    fee_cents: a.fee ?? 0,
    payment_method: "offline",
    payment_instructions: "Pay at the desk, quoting {{reference}}",
    approval: a.approval ?? "auto",
  });
  const reg = await seedRegistration(competition.id, division.id, settings, {
    displayName: "Join State Team",
    contactEmail: "captain@test.local",
    status: a.status ?? "confirmed",
    players: (a.players ?? []).map((name) => ({ name })),
  });
  const joinCode = `JN${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  await sql`update registrations set join_code = ${joinCode} where id = ${reg.registration.id}`;
  const slots = await sql<{ id: string; full_name: string }[]>`
    select id, full_name from registration_players where registration_id = ${reg.registration.id} order by full_name`;
  return { owner, division, regId: reg.registration.id, joinCode, slots };
}

const join = (code: string, over: { player_id?: string; name?: string } = {}) =>
  joinTeamEntry(
    { sessionUserId: null },
    {
      join_code: code,
      player_id: over.player_id ?? null,
      player: { full_name: over.name ?? "Sam Joiner", dob: "1995-05-01", email: null },
      privacy_consent: true,
    },
  );

describe.skipIf(!HAS_DB)("the join answers where the entry stands (polish wave P3)", () => {
  it("every state the entry rests in is reported, per the rulebook (the table, not a sample)", async () => {
    const table: { name: string; entry: Parameters<typeof entry>[0]; want: string | null }[] = [
      { name: "confirmed", entry: { status: "confirmed" }, want: "confirmed" },
      { name: "waitlisted", entry: { status: "waitlisted", fee: 1500 }, want: "waitlisted" },
      { name: "pending, fee owed, auto-approval", entry: { status: "pending", fee: 1500, approval: "auto" }, want: "payment" },
      { name: "pending, free, manual approval", entry: { status: "pending", fee: 0, approval: "manual" }, want: "approval" },
      { name: "pending, fee owed AND manual approval", entry: { status: "pending", fee: 1500, approval: "manual" }, want: "payment_and_approval" },
      { name: "paid, manual approval: the fee is settled, approval remains", entry: { status: "paid", fee: 1500, approval: "manual" }, want: "approval" },
      { name: "pending with nothing to wait on names nothing (never 'confirmed')", entry: { status: "pending", fee: 0, approval: "auto" }, want: null },
    ];
    let checked = 0;
    for (const c of table) {
      const e = await entry(c.entry);
      const result = await join(e.joinCode);
      expect(result.entry_state, c.name).toBe(c.want);
      checked += 1;
    }
    expect(checked, "anti-vacuity: every row was driven").toBe(table.length);
    expect(table.length).toBeGreaterThan(0);
  });

  it("a CLAIM of a captain-entered slot reports the same state as a new joiner (both branches of the write)", async () => {
    // The table above drives the INSERT branch (no seeded players). This drives the CLAIM branch against the same standing.
    const e = await entry({ status: "pending", fee: 1500, approval: "manual", players: ["Captain Person", "Slot Person"] });
    const slot = e.slots.find((s) => s.full_name === "Slot Person");
    expect(slot, "premise: the slot exists").toBeTruthy();
    const claimed = await join(e.joinCode, { player_id: slot!.id, name: "Slot Person" });
    expect(claimed.entry_state).toBe("payment_and_approval");
    const inserted = await join((await entry({ status: "pending", fee: 1500, approval: "manual" })).joinCode, { name: "Newcomer" });
    expect(inserted.entry_state).toBe("payment_and_approval");
  });

  it("the state is read LIVE: the entry confirms between two joins and the second joiner is told so", async () => {
    const e = await entry({ status: "pending", fee: 1500, approval: "auto", players: ["First Joiner", "Second Joiner"] });
    const [first, second] = ["First Joiner", "Second Joiner"].map((n) => e.slots.find((s) => s.full_name === n)!.id);
    expect((await join(e.joinCode, { player_id: first, name: "First Joiner" })).entry_state).toBe("payment");
    await sql`update registrations set status = 'confirmed' where id = ${e.regId}`;
    expect((await join(e.joinCode, { player_id: second, name: "Second Joiner" })).entry_state).toBe("confirmed");
  });

  it("the review mode is read live too: a division switched to auto-approval stops waiting on approval", async () => {
    const e = await entry({ status: "paid", fee: 1500, approval: "manual", players: ["Before", "After"] });
    const [before, after] = ["Before", "After"].map((n) => e.slots.find((s) => s.full_name === n)!.id);
    expect((await join(e.joinCode, { player_id: before, name: "Before" })).entry_state).toBe("approval");
    await putRegistrationSettings(e.owner, e.division.id, {
      ...SETTINGS_BASE,
      entrant_kind: "team",
      fee_cents: 1500,
      payment_method: "offline",
      payment_instructions: "Pay at the desk, quoting {{reference}}",
      approval: "auto",
    });
    expect((await join(e.joinCode, { player_id: after, name: "After" })).entry_state).toBeNull();
  });
});

describe.skipIf(!HAS_DB)("the join preview says what kind of entry the link joins (polish wave P3, W3)", () => {
  it("a team link says team, a pair link says pair", async () => {
    const team = await entry({ kind: "team", players: ["A One"] });
    const pair = await entry({ kind: "pair", players: ["B One", "B Two"] });
    expect((await previewJoinEntry(team.joinCode)).entrant_kind).toBe("team");
    expect((await previewJoinEntry(pair.joinCode)).entrant_kind).toBe("pair");
  });

  it("a pair with BOTH slots unclaimed is not full; claiming one leaves one open; claiming both fills it (the sequence behind 'This pair is full')", async () => {
    const pair = await entry({ kind: "pair", players: ["B One", "B Two"] });
    expect(pair.slots.length, "premise: two slots").toBe(2);
    const fullness = async () => {
      const p = await previewJoinEntry(pair.joinCode);
      return { unclaimed: p.unclaimed_slots.length, allowNew: p.allow_new_player, kind: p.entrant_kind };
    };
    expect(await fullness()).toEqual({ unclaimed: 2, allowNew: false, kind: "pair" });
    await join(pair.joinCode, { player_id: pair.slots[0]!.id, name: "B One" });
    expect(await fullness()).toEqual({ unclaimed: 1, allowNew: false, kind: "pair" });
    await join(pair.joinCode, { player_id: pair.slots[1]!.id, name: "B Two" });
    expect(await fullness()).toEqual({ unclaimed: 0, allowNew: false, kind: "pair" });
  });
});
