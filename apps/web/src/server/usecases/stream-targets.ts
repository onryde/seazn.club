import "server-only";
// server/usecases/stream-targets.ts — destinations (design §6.1 org_stream_targets). The list is
// a projection without the key; the key is read by the provision step alone
// (server/relay/secret-columns.ts). `watchUrl` is validated by the ONE
// allowlist (lib/stream-url.ts, R16) at the schema, and re-checked here so a
// caller that bypasses parseBody still cannot store an off-list host.
// The ingest url is the platform's preset (D6); `checkDestination` still runs on it as a guard, so a
// preset the allowlist stopped admitting refuses by rule, never silently.
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { DESTINATION_NOT_ALLOWED, STREAM_PLATFORM_PRESETS, checkDestination, type DestinationRefusal } from "@/lib/stream-destinations";
import { streamUrlSchema } from "@/lib/stream-url";
import type { AuthCtx } from "@/server/api-v1/auth";
import type { CreateStreamTarget, StreamTarget } from "@/server/api-v1/schemas";
import { insertStreamTarget, readKeyHints, type StoredStreamTarget } from "@/server/relay/secret-columns";
import { holderRows, listHolder, type TargetHolder } from "./stream-target-holders";

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
  const [rows, hints, holders] = await Promise.all([
    sql<{ id: string; kind: StreamTarget["kind"]; label: string; watch_url: string | null; created_at: string }[]>`
      select id, kind, label, watch_url, created_at from org_stream_targets
       where org_id = ${orgId} and archived_at is null order by created_at asc`,
    sql.begin((tx) => readKeyHints(tx, orgId)) as Promise<Map<string, string | null>>,
    holderRows(sql, { orgId }),
  ]);
  // holderRows is oldest-first, so the FIRST holder seen for a target is the one the list names.
  const heldBy = new Map<string, TargetHolder>();
  for (const h of holders) if (!heldBy.has(h.targetId)) heldBy.set(h.targetId, h);
  return rows.map((r) => {
    const h = heldBy.get(r.id);
    return {
      id: r.id, kind: r.kind, label: r.label, watchUrl: r.watch_url, createdAt: new Date(r.created_at).toISOString(),
      keyHint: hints.get(r.id) ?? null, inUse: h ? listHolder(h) : null,
    };
  });
}

export async function createStreamTarget(auth: AuthCtx, orgId: string, body: CreateStreamTarget): Promise<StreamTarget> {
  if (auth.orgId !== orgId) throw new HttpError(404, "organization not found");
  // Task 9 review minor 7: surrounding whitespace is the commonest paste error from a platform dashboard, and it is
  // part of no stream key any listed service issues. It is TRIMMED, not refused: the organiser cannot see it, so a
  // refusal is a round trip over an invisible character, while the trimmed value is exactly what the platform issued.
  // Untrimmed, a key sealed with a trailing newline was a permanent dead row (G3).
  const streamKey = body.streamKey.trim();
  // D6: the url is the platform's preset — sealed in the CANONICAL form the validator accepted (the bytes dialled are
  // the bytes checked), and refused by rule if the allowlist ever stops admitting it.
  const destination = checkDestination(STREAM_PLATFORM_PRESETS[body.kind]);
  if (!destination.ok) throw new DestinationNotAllowedError(destination.rule);
  // A whitespace-only key passes the schema's min(1) and is nothing once trimmed.
  if (streamKey === "") throw new HttpError(422, "The stream key is empty");
  const watch = body.watchUrl === undefined ? null : streamUrlSchema.safeParse(body.watchUrl);
  if (watch && !watch.success) throw new HttpError(422, "invalid watch link");
  const watchUrl = watch ? watch.data : null;
  // A19 + D2: the same destination again is the EXISTING target, or its most recently archived row restored
  // (insertStreamTarget), so the reply is the STORED row — never this body echoed onto an id it did not write.
  const stored = (await sql.begin((tx) =>
    insertStreamTarget(tx, { orgId, kind: body.kind, label: body.label, watchUrl, rtmp: { url: destination.url, streamKey } }),
  )) as StoredStreamTarget;
  // Read back through the list, so `keyHint` and `inUse` come from the one projection. A row archived between the
  // insert and this read is a 409 retry, never a 500.
  const row = (await listStreamTargets(auth, orgId)).find((t) => t.id === stored.id);
  if (!row) throw new HttpError(409, "the destination changed while it was being saved; try again");
  return row;
}
