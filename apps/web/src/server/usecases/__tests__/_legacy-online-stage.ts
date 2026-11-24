// Online Chess task 8 (spec 2026-11-23-online-chess-credits-design.md §7.6, P16): an ONLINE division takes Swiss and knockout stages
// only, so `createStages` and `replaceStages` refuse a league (or a group, a ladder, an americano) for one with 422
// ONLINE_FORMAT_NOT_SUPPORTED, and a division holding one cannot turn online play on. Such divisions still STAND - staging holds
// online divisions with a league, made before the gate - and the suites that prove how an online division with a league plays
// (the camera readers, the round-open stamp, the entrant doors under a league's format max) need that shape.
//
// This builds it the way it came to be: the stage is written through the REAL door while online play is off, then online play is
// switched back on by direct SQL (the package row, written when the division was created online, is untouched). Use it to seed the
// legacy shape, never to prove a gate: a suite that asserts the refusal calls `createStages` itself.
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { createStages } from "../stages";

type CreateStagesInput = Parameters<typeof createStages>[2];

/** `createStages` for a division that plays online, with the stage kind a refused one: online play is turned off around the write
 *  (when it was on) and restored exactly as it was, so the stage is written by the door's real defaults and the division ends
 *  online. A division that does not play online passes straight through. */
export async function createStagesOnLegacyOnline(auth: AuthCtx, divisionId: string, input: CreateStagesInput) {
  const [before] = await sql<{ mode: string | null }[]>`select config->>'onlinePlay' as mode from divisions where id = ${divisionId}`;
  if (before?.mode !== "lichess") return createStages(auth, divisionId, input);
  await sql`update divisions set config = config || '{"onlinePlay":"off"}'::jsonb where id = ${divisionId}`;
  try {
    return await createStages(auth, divisionId, input);
  } finally {
    await sql`update divisions set config = config || '{"onlinePlay":"lichess"}'::jsonb where id = ${divisionId}`;
  }
}
