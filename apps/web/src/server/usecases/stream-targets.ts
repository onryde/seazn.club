import "server-only";
// server/usecases/stream-targets.ts — destinations (design §6.1). The list is
// a projection without the key; the key is read by the provision step alone
// (server/relay/secret-columns.ts). `watchUrl` is validated by the ONE
// allowlist (lib/stream-url.ts, R16) at the schema, and re-checked here so a
// caller that bypasses parseBody still cannot store an off-list host.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { streamUrlSchema } from "@/lib/stream-url";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStreamTarget, StreamTarget } from "@/server/api-v1/schemas";
import { insertStreamTarget } from "@/server/relay/secret-columns";

export async function listStreamTargets(auth: AuthCtx, orgId: string): Promise<StreamTarget[]> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  const rows = await sql<{ id: string; kind: StreamTarget["kind"]; label: string; watch_url: string | null; created_at: string }[]>`
    select id, kind, label, watch_url, created_at from org_stream_targets
     where org_id = ${orgId} order by created_at asc`;
  return rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, watchUrl: r.watch_url, createdAt: new Date(r.created_at).toISOString() }));
}

export async function createStreamTarget(auth: AuthCtx, orgId: string, body: CreateStreamTarget): Promise<StreamTarget> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  const watch = body.watchUrl === undefined ? null : streamUrlSchema.safeParse(body.watchUrl);
  if (watch && !watch.success) throw new HttpError(422, "invalid watch link");
  const watchUrl = watch ? watch.data : null;
  const id = (await sql.begin((tx) =>
    insertStreamTarget(tx, { orgId, kind: body.kind, label: body.label, watchUrl, rtmp: { url: body.rtmpUrl, streamKey: body.streamKey } }),
  )) as string;
  const [row] = await sql<{ created_at: string }[]>`select created_at from org_stream_targets where id = ${id}`;
  return { id, kind: body.kind, label: body.label, watchUrl, createdAt: new Date(row!.created_at).toISOString() };
}
