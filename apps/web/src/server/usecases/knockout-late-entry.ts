import "server-only";
// W4 app-A Tasks 9–11 (rules X-LE-1…X-LE-13; spec 2026-11-04-format-matrix-w4-knockout-design.md §4.1; rulings 263,
// 271): late entry into a drawn ROOT knockout.
//
// T9: which stage a late player joins — the division's root knockout (`isRootKnockoutStage`, lib/open-entry-stages.ts:
// the ONE predicate the Start lock, this admission and the desk's client mirror all read). A knockout fed by an earlier
// stage (league_ko, groups_ko, swiss_knockout, ko_plate's plate, qualifying_main's main draw) never takes one (X-LE-2).
import type postgres from "postgres";
import { isRootKnockoutStage } from "@/lib/open-entry-stages";

type Tx = postgres.TransactionSql;

export interface KnockoutEntryStage {
  id: string;
  seq: number;
  status: string;
  kind: string;
  name: string;
  progression: unknown;
  config: Record<string, unknown>;
}

/** The division's stages in `seq` order — the whole list, since a root knockout is the division's ENTRY stage (its
 *  lowest `seq`), which no per-stage read can answer. */
async function divisionStages(tx: Tx, divisionId: string): Promise<KnockoutEntryStage[]> {
  return tx<KnockoutEntryStage[]>`
    select id, seq, status, kind, name, progression, config from stages
    where division_id = ${divisionId} order by seq`;
}

/** The division's root knockout — the stage a late player joins — or null (none: another format, or a fed bracket). */
export async function rootKnockoutStage(tx: Tx, divisionId: string): Promise<KnockoutEntryStage | null> {
  const stages = await divisionStages(tx, divisionId);
  return stages.find((s) => isRootKnockoutStage(s, stages)) ?? null;
}

/** Whether the division holds a knockout a late player can join — the Start lock's exemption (`createEntrants`), the
 *  neighbour of `hasRootSwissStage`. */
export async function hasRootKnockoutStage(tx: Tx, divisionId: string): Promise<boolean> {
  return (await rootKnockoutStage(tx, divisionId)) !== null;
}
