import "server-only";
// #622 — the WRITE path for stage- and round-scoped required court tags, and
// the only one either scope has ever had.
//
// `stages.required_court_tags` shipped with V367 as a read-only column: the
// scheduler consumed it, nothing could set it, and the 2026-08-17 P9 session
// status recorded the consequence explicitly — "Owed when
// `stages.required_court_tags` gains a write path: per-fixture stage-tag
// resolution in all three paths, through the one shared `candidate-courts`
// function — not three copies. Whoever adds the write path owns this." This
// module is that write path, and #622's per-fixture resolution
// (`court-candidates.ts`'s `requiredCourtTagsByFixture`) is that debt paid: a
// stage tag can only be authored here now that no path resolves it by
// flattening every stage's tags into one list.
//
// ROUNDS ARE ADDRESSED BY ROLE, never by `fixtures.round_no` — see V375's
// header for the two ways a round_no key silently addresses the wrong fixtures
// (sparse double-elim numbering, and a draw resize renumbering every round).
import { HttpError } from "@/lib/errors";
import { isRoundRoleKey, roundRoleKey } from "@seazn/engine/competition";
import { roundRoleFor } from "@/lib/round-role-label";
import type { AuthCtx } from "@/server/api-v1/auth";
import { withTenant } from "@/lib/db";
import { normalizeTags } from "./venues";

export interface StageRoundCourtTags {
  /** A `roundRoleKey()` value — `final`, `semi_final`, `plain_round_3`, … */
  round_role: string;
  required_court_tags: string[];
}

export interface StageCourtTags {
  stage_id: string;
  /** V367's stage-wide requirement — every fixture in the stage. */
  required_court_tags: string[];
  /** Round-scoped requirements, narrowing the stage-wide list further for the
   *  rounds named. Sorted by role key so the response is stable. */
  rounds: StageRoundCourtTags[];
  /**
   * Every round role this stage's fixtures ACTUALLY occupy right now, in
   * bracket order (earliest round first, lanes in persistence order).
   *
   * Returned so the console can offer a picker of real rounds instead of
   * asking an organiser to type `losers_round_2`. Deliberately NOT a
   * constraint on what may be WRITTEN: a stage whose fixtures have not been
   * generated yet occupies no roles at all, and refusing a rule until the
   * draw exists would make the setup-time ordering the console actually uses
   * impossible. A stored role no fixture occupies is inert, not corrupt (V375
   * header).
   */
  available_round_roles: string[];
}

/** Shared by the GET and the PUT: they must agree about what a stage's roles
 *  are, and about which stage belongs to which org. */
async function stageOrThrow(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  stageId: string,
): Promise<{ id: string; org_id: string; kind: string }> {
  const [stage] = await tx<{ id: string; org_id: string; kind: string }[]>`
    select id, org_id, kind from stages where id = ${stageId}`;
  if (!stage) throw new HttpError(404, "stage not found");
  return stage;
}

async function availableRoundRoles(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  stageId: string,
  stageKind: string,
): Promise<string[]> {
  const fixtures = await tx<
    {
      round_no: number;
      lane: "WB" | "LB" | "GF" | null;
      is_final: boolean;
      third_place: boolean;
      conditional: boolean;
      ext_key: string | null;
    }[]
  >`
    select round_no, lane, is_final, third_place, conditional, ext_key
    from fixtures where stage_id = ${stageId}
    order by round_no, seq_in_round`;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of fixtures) {
    // The SAME namer the resolution path uses (`court-candidates.ts`'s
    // `requiredCourtTagsByFixture`) over the SAME fixture list, so a role the
    // picker offers is always a role a fixture will actually resolve to. A
    // second derivation here is how the offered vocabulary and the matched
    // vocabulary drift apart, which for a rule keyed by string means a tag
    // that silently applies to nothing.
    const key = roundRoleKey(roundRoleFor(fixtures, f, stageKind, f.ext_key));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export async function getStageCourtTags(
  auth: AuthCtx,
  stageId: string,
): Promise<StageCourtTags> {
  return withTenant(auth.orgId, async (tx) => {
    const stage = await stageOrThrow(tx, stageId);
    const [row] = await tx<{ required_court_tags: string[] }[]>`
      select required_court_tags from stages where id = ${stageId}`;
    const rounds = await tx<{ round_role: string; required_court_tags: string[] }[]>`
      select round_role, required_court_tags
      from stage_round_court_tags where stage_id = ${stageId}
      order by round_role`;
    return {
      stage_id: stageId,
      required_court_tags: row?.required_court_tags ?? [],
      rounds: rounds.map((r) => ({
        round_role: r.round_role,
        required_court_tags: r.required_court_tags,
      })),
      available_round_roles: await availableRoundRoles(tx, stageId, stage.kind),
    };
  });
}

export interface PutStageCourtTagsInput {
  required_court_tags?: string[];
  /** WHOLE-LIST REPLACE, not a merge: an omitted round is DELETED. A partial
   *  merge would give the console no way to remove a rule at all (an empty tag
   *  list is a legitimate "no requirement" row, not a delete), and PUT is the
   *  method whose contract already says "this is the new state". */
  rounds?: StageRoundCourtTags[];
}

export async function putStageCourtTags(
  auth: AuthCtx,
  stageId: string,
  input: PutStageCourtTagsInput,
): Promise<StageCourtTags> {
  // Normalised here, at the write, the same way `divisions.ts`'s
  // `patchDivision` normalises its own `required_court_tags` — one rule
  // (trim/lowercase/dedupe/drop-empties), one copy, imported from the courts
  // path that owns it. `unionRequiredCourtTags` normalises defensively on the
  // read side too, so a row written before this path existed still resolves,
  // but a stored value should be canonical.
  const stageTags =
    input.required_court_tags !== undefined ? normalizeTags(input.required_court_tags) : undefined;
  const rounds = input.rounds?.map((r) => {
    if (!isRoundRoleKey(r.round_role)) {
      // Refused rather than stored: the column is a primary key, so a typo is
      // not a value that merely fails to match today — it is a row that can
      // never match any fixture, silently, forever, while the console shows
      // the organiser a rule they believe is in force.
      throw new HttpError(
        422,
        `unknown round role "${r.round_role}"`,
        "UNKNOWN_ROUND_ROLE",
      );
    }
    return { round_role: r.round_role, required_court_tags: normalizeTags(r.required_court_tags) };
  });
  if (rounds !== undefined) {
    const seen = new Set<string>();
    for (const r of rounds) {
      if (seen.has(r.round_role)) {
        throw new HttpError(
          422,
          `round role "${r.round_role}" listed twice`,
          "DUPLICATE_ROUND_ROLE",
        );
      }
      seen.add(r.round_role);
    }
  }

  return withTenant(auth.orgId, async (tx) => {
    const stage = await stageOrThrow(tx, stageId);
    if (stageTags !== undefined) {
      await tx`update stages set required_court_tags = ${tx.array(stageTags)} where id = ${stageId}`;
    }
    if (rounds !== undefined) {
      // Delete-then-insert inside the caller's transaction, rather than an
      // upsert plus a delete of the complement: the complement query needs the
      // incoming role list as a bind array anyway, and two statements that can
      // disagree about which rows survive is a worse trade than rewriting a
      // handful of rows. A stage carries at most one row per round.
      await tx`delete from stage_round_court_tags where stage_id = ${stageId}`;
      for (const r of rounds) {
        await tx`
          insert into stage_round_court_tags (stage_id, org_id, round_role, required_court_tags)
          values (${stageId}, ${stage.org_id}, ${r.round_role}, ${tx.array(r.required_court_tags)})`;
      }
    }
    const [row] = await tx<{ required_court_tags: string[] }[]>`
      select required_court_tags from stages where id = ${stageId}`;
    const stored = await tx<{ round_role: string; required_court_tags: string[] }[]>`
      select round_role, required_court_tags
      from stage_round_court_tags where stage_id = ${stageId}
      order by round_role`;
    return {
      stage_id: stageId,
      required_court_tags: row?.required_court_tags ?? [],
      rounds: stored.map((r) => ({
        round_role: r.round_role,
        required_court_tags: r.required_court_tags,
      })),
      available_round_roles: await availableRoundRoles(tx, stageId, stage.kind),
    };
  });
}
