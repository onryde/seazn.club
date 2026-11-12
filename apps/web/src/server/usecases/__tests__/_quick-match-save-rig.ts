// Shared by the quick match save suites (plan 3 Task 4: quick-match-save.test.ts, the sign-in doors' suite and the account
// deletion's): a quick match a guest typed an address on, made by the REAL producer (`createQuickMatch`), and the one read
// every suite asks of its own rows. Not a test file (no `.test.` in its name), so vitest never collects it.
//
// Every match is its own (a fresh name and visitor): the system org is shared by every case, run and parallel file (A16),
// so nothing here counts the org's rows. The caller stubs DEVICE_LINK_KEK (every create seals a home token) and mocks
// `captureServer` if it does not want the create's event.
//
// One sport on purpose: saving reads no sport, division or fixture, only the `quick_matches` row, so a second sport would
// re-run the same UPDATE. Badminton is the sport the quick match suites already use.
import { randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { CreateQuickMatch } from "@/server/api-v1/schemas";
import { createQuickMatch, type CreatedQuickMatch } from "../quick-match-create";
import { hardDeleteQuickMatchCompetition } from "../quick-match-delete";
import { hashVisitorKey, mintVisitorKey } from "../quick-match-tokens";

let badmintonVariant: string | null = null;
const made: string[] = [];

/** Read from the catalog, never typed (as plan 1's suites do). */
async function badminton(): Promise<string> {
  if (badmintonVariant) return badmintonVariant;
  const [row] = await sql<{ key: string }[]>`
    select key from sport_variants where sport_key = 'badminton' and is_system and org_id is null order by key limit 1`;
  if (!row) throw new Error("no system badminton variant: run `npm run sync:sports` against this database");
  badmintonVariant = row.key;
  return row.key;
}

/** A guest's quick match with `email` typed on it (null: none typed), through the real create. */
export async function createTypedMatch(email: string | null): Promise<CreatedQuickMatch> {
  const input: CreateQuickMatch = {
    name: `QM save ${randomUUID().slice(0, 8)}`,
    sport_key: "badminton",
    variant_key: await badminton(),
    kind: "pair",
    format: "league",
    sides: ["Ravi & Sam", "Priya & Tom"],
    plays: 1,
    email,
    locale: "en",
  };
  const out = await createQuickMatch(input, {
    visitorHash: hashVisitorKey(mintVisitorKey()),
    baseUrl: "https://qm-save.test", // an emailed create queues its link mail (plan 3 Task 1), whose link needs a base
  });
  made.push(out.competitionId);
  return out;
}

export interface SaveState {
  saved_by_user_id: string | null;
  email: string | null;
  expires_at: Date | null;
  reminder_sent_at: Date | null;
  last_activity_at: Date;
}

/** The columns a save, a release or a sweep writes, read on the pool (past RLS) so the read cannot hide a row. */
export async function saveStateOf(quickMatchId: string): Promise<SaveState> {
  const [row] = await sql<SaveState[]>`
    select saved_by_user_id, email, expires_at, reminder_sent_at, last_activity_at from quick_matches where id = ${quickMatchId}`;
  if (!row) throw new Error(`precondition: quick match ${quickMatchId} has no row`);
  return row;
}

/** A unique address for one case. `tag` names the suite in the address, so a leftover row says where it came from. */
export const addressFor = (tag: string): string => `qm-save-${tag}-${randomUUID().slice(0, 8)}@test.local`;

/** Hard-delete every match this process made (the plan-1 delete: its outbox rows, its row, its competition). */
export async function deleteMadeMatches(): Promise<void> {
  for (const competitionId of made.splice(0)) await hardDeleteQuickMatchCompetition(competitionId);
}
