import "server-only";
// server/usecases/stream-targets.ts — destinations (design §6.1). The list is
// a projection without the key; the key is read by the provision step alone
// (server/relay/secret-columns.ts). `watchUrl` is validated by the ONE
// allowlist (lib/stream-url.ts, R16) at the schema, and re-checked here so a
// caller that bypasses parseBody still cannot store an off-list host.
// `rtmpUrl` — the address the relay DIALS — is checked HERE, not at the schema
// (A18, G2): the ONE destination validator (lib/stream-destinations.ts) owns
// every rtmpUrl rule, and its refusal is a typed 422 with a stable code, which
// a schema refinement could only surface as a generic 400 VALIDATION.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { DESTINATION_NOT_ALLOWED, checkDestination, type DestinationRefusal } from "@/lib/stream-destinations";
import { streamUrlSchema } from "@/lib/stream-url";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStreamTarget, StreamTarget } from "@/server/api-v1/schemas";
import { insertStreamTarget } from "@/server/relay/secret-columns";

// English API sentences, one per rule. Never the URL: its path can carry the stream key.
const REFUSAL_MESSAGE: Record<DestinationRefusal, string> = {
  scheme: "The ingest URL must start with rtmp:// or rtmps://",
  userinfo: "The ingest URL must not carry a username or password",
  ip_literal: "The ingest URL must name the streaming service's host, not an IP address",
  host: "The ingest host is not one of the supported streaming services",
  port: "The ingest URL uses a port the streaming service does not publish",
  path: "The ingest URL needs the service's application path (e.g. /live2)",
};

/** 422 DESTINATION_NOT_ALLOWED, `rule` = which check refused (A18). */
export class DestinationNotAllowedError extends HttpError {
  constructor(public readonly rule: DestinationRefusal) {
    super(422, REFUSAL_MESSAGE[rule], DESTINATION_NOT_ALLOWED, { rule });
  }
}

export async function listStreamTargets(auth: AuthCtx, orgId: string): Promise<StreamTarget[]> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  const rows = await sql<{ id: string; kind: StreamTarget["kind"]; label: string; watch_url: string | null; created_at: string }[]>`
    select id, kind, label, watch_url, created_at from org_stream_targets
     where org_id = ${orgId} order by created_at asc`;
  return rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, watchUrl: r.watch_url, createdAt: new Date(r.created_at).toISOString() }));
}

export async function createStreamTarget(auth: AuthCtx, orgId: string, body: CreateStreamTarget): Promise<StreamTarget> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  // Seal the CANONICAL url the validator accepted, never the raw body: the bytes dialled are the bytes checked.
  const destination = checkDestination(body.rtmpUrl);
  if (!destination.ok) throw new DestinationNotAllowedError(destination.rule);
  const watch = body.watchUrl === undefined ? null : streamUrlSchema.safeParse(body.watchUrl);
  if (watch && !watch.success) throw new HttpError(422, "invalid watch link");
  const watchUrl = watch ? watch.data : null;
  const id = (await sql.begin((tx) =>
    insertStreamTarget(tx, { orgId, kind: body.kind, label: body.label, watchUrl, rtmp: { url: destination.url, streamKey: body.streamKey } }),
  )) as string;
  const [row] = await sql<{ created_at: string }[]>`select created_at from org_stream_targets where id = ${id}`;
  return { id, kind: body.kind, label: body.label, watchUrl, createdAt: new Date(row!.created_at).toISOString() };
}
