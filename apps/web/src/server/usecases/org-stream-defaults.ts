import "server-only";
// server/usecases/org-stream-defaults.ts — the club's default Score style and Score timing (Seazn-hosted video, Phase 4, Task 38;
// V558 `org_stream_defaults`). One row per organisation, made by its first save; no row reads as "the club sets nothing".
//
// What a stream does with them is decided where a session is created (stream-sessions/start.ts, one statement), never here:
//   style:  the match's own choice, else the club's, else the sport's default;
//   timing: the match's own, else the club's, else the default — except a COURT session, which takes the club's STYLE and never its
//           timing (owner, 2026-11-24). The session copies both at its start, so a change here never moves a running stream.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { isKnownTemplate, NO_CLUB_STREAM_PREFS_READ, type ClubStreamPrefsRead } from "@/lib/stream-settings";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { PutOrgStreamDefaults } from "@/server/api-v1/schemas";

/** The org's stored defaults, with the row's revision; an org with no row reads `NO_CLUB_STREAM_PREFS_READ`. The caller has already
 *  authorised the org (the route's door, or the Streaming page's own). */
export async function orgStreamDefaultsOf(orgId: string): Promise<ClubStreamPrefsRead> {
  const [row] = await sql<{ overlay_template: string | null; overlay_delay_ms: number | null; revision: number }[]>`
    select overlay_template, overlay_delay_ms, revision::float8 as revision from org_stream_defaults where org_id = ${orgId}`;
  return row === undefined ? NO_CLUB_STREAM_PREFS_READ : { overlayTemplate: row.overlay_template, overlayDelayMs: row.overlay_delay_ms, revision: row.revision };
}

/** The club's defaults, each written only when the body names it (`null` clears it). Editors only — the route's door asks
 *  `requireOrgAuth(…, "write")` (owner / admin; a paused admin seat is refused there, 402) — and another org's id is the 404.
 *  ONE statement: the row is made by the first save and every save bumps `revision` under the row lock, so a second save with
 *  the same body is the same answer at a higher revision. An id the registry does not serve (unknown or retired) is a 400
 *  before anything is written. */
export async function saveOrgStreamDefaults(auth: AuthCtx, orgId: string, body: PutOrgStreamDefaults): Promise<ClubStreamPrefsRead> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  if (body.overlayTemplate != null && !isKnownTemplate(body.overlayTemplate)) {
    throw new HttpError(400, "overlay template not available");
  }
  const templateNamed = body.overlayTemplate !== undefined;
  const delayNamed = body.overlayDelayMs !== undefined;
  const [row] = await sql<{ overlay_template: string | null; overlay_delay_ms: number | null; revision: number }[]>`
    insert into org_stream_defaults (org_id, overlay_template, overlay_delay_ms, updated_by, updated_at, revision)
    values (${orgId}, ${body.overlayTemplate ?? null}, ${body.overlayDelayMs ?? null}, ${auth.userId}, now(), 1)
    on conflict (org_id) do update
       set overlay_template = case when ${templateNamed}::boolean then excluded.overlay_template else org_stream_defaults.overlay_template end,
           overlay_delay_ms = case when ${delayNamed}::boolean then excluded.overlay_delay_ms else org_stream_defaults.overlay_delay_ms end,
           updated_by = excluded.updated_by, updated_at = now(),
           revision = org_stream_defaults.revision + 1
    returning overlay_template, overlay_delay_ms, revision::float8 as revision`;
  if (!row) throw new Error(`saveOrgStreamDefaults: org ${orgId} wrote no row`);
  return { overlayTemplate: row.overlay_template, overlayDelayMs: row.overlay_delay_ms, revision: row.revision };
}
