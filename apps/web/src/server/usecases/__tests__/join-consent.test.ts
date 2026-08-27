// RS007 review defect #4 (HIGH) — joinTeamEntry's per-player consent
// persistence. The join page renders a CONSENT step and hard-blocks submit
// on privacy consent, but PublicJoinRequest had no field to receive either
// flag and joinTeamEntry had nowhere to record them PER PLAYER: a joiner's
// privacy consent was never recorded, and a deliberate media-consent
// REFUSAL was silently overridden by the CAPTAIN's own group-level choice
// (registration_groups.media_consent_at, stamped at cart submit). Fixed by
// V384 (registration_players.privacy_consent_at/.version,
// media_consent_at/.version) plus joinTeamEntry persisting both, per
// player, in BOTH the claim (UPDATE) and insert (INSERT) branches — never
// on the group. Real Postgres required; skipped without DATABASE_URL, same
// convention as registration-submit.test.ts (this suite's sibling, whose
// own `joinTeamEntry` describe block owns the structural/status-code
// coverage this file deliberately does not repeat).
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import { LEGAL_VERSION } from "@/lib/legal";
import { asOwner, rig, seedOrg } from "./_registration-fixtures";
import { joinTeamEntry, submitRegistrationGroup, type SubmitGroupContact } from "../registration-submit";

const HAS_DB = !!process.env.DATABASE_URL;

/** `registration_settings` needs `approval`/`allow_free_agents` (V364) that
 *  `putRegistrationSettings` does not yet write — direct SQL, matching the
 *  established fixture-seeding pattern for this schema (registration-
 *  submit.test.ts's own seedSettings). */
async function seedTeamSettings(divisionId: string): Promise<void> {
  await sql`
    insert into registration_settings
      (division_id, enabled, entrant_kind, fee_cents, capacity, payment_method, approval, allow_free_agents)
    values (${divisionId}, true, 'team', 0, null, 'offline', 'auto', false)
    on conflict (division_id) do update set
      enabled = excluded.enabled, entrant_kind = excluded.entrant_kind, fee_cents = excluded.fee_cents`;
}

function baseContact(): SubmitGroupContact {
  return { name: "Captain", email: `cap-${randomUUID().slice(0, 8)}@test.local` };
}

/** Seeds a real, joinable team entry (submitRegistrationGroup mints the
 *  join_code — same convention registration-submit.test.ts's own
 *  teamRig/rosterRig use) with the given captain-entered player names, and
 *  returns those rows so a test can claim one by id without hand-deriving
 *  it. `groupMediaConsent` lets a test seed the CAPTAIN's OWN group-level
 *  choice — the money fixture for proving a joiner's later per-player
 *  choice never inherits it. */
async function teamWithRoster(
  playerNames: string[],
  opts: { groupMediaConsent?: boolean } = {},
): Promise<{
  orgSlug: string;
  joinCode: string;
  registrationId: string;
  players: { id: string; full_name: string }[];
}> {
  const { orgId, orgSlug, ownerId } = await seedOrg("pro");
  const owner = asOwner(orgId, ownerId);
  const { competition, division } = await rig(owner);
  await seedTeamSettings(division.id);
  const submitted = await submitRegistrationGroup(
    { orgSlug, compSlug: competition.slug },
    {
      contact: baseContact(),
      privacy_consent: true,
      media_consent: opts.groupMediaConsent ?? false,
      entries: [
        {
          division_id: division.id,
          entrant_kind: "team",
          team_name: "Joinable Team",
          players: playerNames.map((full_name) => ({ full_name })),
          answers: {},
        },
      ],
    },
  );
  const entry = submitted.entries[0]!;
  const players = await sql<{ id: string; full_name: string }[]>`
    select id, full_name from registration_players
    where registration_id = ${entry.registration_id} order by full_name`;
  return { orgSlug, joinCode: entry.join_code!, registrationId: entry.registration_id, players };
}

async function playerConsentRow(playerId: string): Promise<{
  privacy_consent_at: Date | null;
  privacy_consent_version: string | null;
  media_consent_at: Date | null;
  media_consent_version: string | null;
}> {
  const [row] = await sql<
    {
      privacy_consent_at: Date | null;
      privacy_consent_version: string | null;
      media_consent_at: Date | null;
      media_consent_version: string | null;
    }[]
  >`
    select privacy_consent_at, privacy_consent_version, media_consent_at, media_consent_version
    from registration_players where id = ${playerId}`;
  return row!;
}

describe.skipIf(!HAS_DB)("joinTeamEntry — per-player consent (RS007 defect #4)", () => {
  describe("claim path — a captain-entered row is UPDATED", () => {
    it("persists privacy_consent_at/.version and media_consent_at/.version on the CLAIMED row", async () => {
      const { joinCode, players } = await teamWithRoster(["Kid One"]);
      const res = await joinTeamEntry(
        {},
        {
          join_code: joinCode,
          player_id: players[0]!.id,
          player: { full_name: "Kid One" },
          privacy_consent: true,
          media_consent: true,
        },
      );
      const row = await playerConsentRow(res.player_id);
      expect(row.privacy_consent_at).not.toBeNull();
      expect(row.privacy_consent_version).toBe(LEGAL_VERSION);
      expect(row.media_consent_at).not.toBeNull();
      expect(row.media_consent_version).toBe(LEGAL_VERSION);
    });

    it("THE bug: a joiner's media-consent REFUSAL survives even when the CAPTAIN granted media consent at submit — never silently overridden by the group", async () => {
      const { joinCode, players } = await teamWithRoster(["Kid One"], { groupMediaConsent: true });
      // Sanity — the group itself really did record a granted media consent,
      // so a failure below can only mean the player row inherited it.
      const [group] = await sql<{ media_consent_at: Date | null }[]>`
        select g.media_consent_at from registration_groups g
        join registrations r on r.group_id = g.id
        where r.join_code = ${joinCode}`;
      expect(group!.media_consent_at).not.toBeNull();

      const res = await joinTeamEntry(
        {},
        {
          join_code: joinCode,
          player_id: players[0]!.id,
          player: { full_name: "Kid One" },
          privacy_consent: true,
          media_consent: false, // an explicit refusal
        },
      );
      const row = await playerConsentRow(res.player_id);
      expect(row.privacy_consent_at).not.toBeNull(); // privacy still recorded
      expect(row.media_consent_at).toBeNull(); // the refusal recorded AS a refusal
      expect(row.media_consent_version).toBeNull();
    });

    it("omitting privacy_consent leaves the stamp null rather than fabricating a consent that was never given", async () => {
      const { joinCode, players } = await teamWithRoster(["Kid One"]);
      const res = await joinTeamEntry(
        {},
        { join_code: joinCode, player_id: players[0]!.id, player: { full_name: "Kid One" } },
      );
      const row = await playerConsentRow(res.player_id);
      expect(row.privacy_consent_at).toBeNull();
      expect(row.privacy_consent_version).toBeNull();
      expect(row.media_consent_at).toBeNull();
    });
  });

  describe("insert path (NEW_PLAYER_CHOICE — player_id omitted)", () => {
    it("persists both consent pairs on the newly INSERTED row", async () => {
      const { joinCode } = await teamWithRoster([]); // zero named players — room under the sport's squad cap
      const res = await joinTeamEntry(
        {},
        { join_code: joinCode, player: { full_name: "New Joiner" }, privacy_consent: true, media_consent: true },
      );
      const row = await playerConsentRow(res.player_id);
      expect(row.privacy_consent_at).not.toBeNull();
      expect(row.privacy_consent_version).toBe(LEGAL_VERSION);
      expect(row.media_consent_at).not.toBeNull();
      expect(row.media_consent_version).toBe(LEGAL_VERSION);
    });

    it("a refusal on the insert path persists as a refusal too", async () => {
      const { joinCode } = await teamWithRoster([]);
      const res = await joinTeamEntry(
        {},
        { join_code: joinCode, player: { full_name: "New Joiner" }, privacy_consent: true, media_consent: false },
      );
      const row = await playerConsentRow(res.player_id);
      expect(row.media_consent_at).toBeNull();
      expect(row.media_consent_version).toBeNull();
    });
  });

  describe("per-player independence — two joiners on the SAME entry get DIFFERENT stored outcomes", () => {
    it("one claims with media consent granted, the other with it refused — never a shared/group-wide flag", async () => {
      const { joinCode, players } = await teamWithRoster(["Kid A", "Kid B"]);
      const a = players.find((p) => p.full_name === "Kid A")!;
      const b = players.find((p) => p.full_name === "Kid B")!;

      const resA = await joinTeamEntry(
        {},
        {
          join_code: joinCode,
          player_id: a.id,
          player: { full_name: "Kid A" },
          privacy_consent: true,
          media_consent: true,
        },
      );
      const resB = await joinTeamEntry(
        {},
        {
          join_code: joinCode,
          player_id: b.id,
          player: { full_name: "Kid B" },
          privacy_consent: true,
          media_consent: false,
        },
      );

      const rowA = await playerConsentRow(resA.player_id);
      const rowB = await playerConsentRow(resB.player_id);
      expect(rowA.media_consent_at).not.toBeNull();
      expect(rowB.media_consent_at).toBeNull();
    });
  });
});
