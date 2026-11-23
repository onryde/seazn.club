// server/client-reports/kinds.ts — the registry of client report kinds (Task 25b), and the route's body: a union on `kind` built from
// it, so the schema the route parses with and the one OpenAPI publishes are the same object. Pure zod: the bare OpenAPI generator loads
// this file (openapi.ts). A new kind is its own file beside video.ts and chess-room.ts and ONE entry in CLIENT_REPORT_KINDS; nothing else names a kind.
import { z } from "zod";
import type { ClientReportKind } from "./define.ts";
import { chessRoomClientReport } from "./chess-room.ts";
import { videoClientReport } from "./video.ts";

/** Every kind, in the order OpenAPI lists them. */
export const CLIENT_REPORT_KINDS = [videoClientReport, chessRoomClientReport] as const;

type KindSchemaOf = (typeof CLIENT_REPORT_KINDS)[number]["schema"];

/** The route's body: exactly one kind's closed object, told apart by `kind`. An unknown kind is a 400. */
export const ClientReport = z.discriminatedUnion(
  "kind",
  CLIENT_REPORT_KINDS.map((k) => k.schema) as [KindSchemaOf, ...KindSchemaOf[]],
);
export type ClientReport = z.infer<typeof ClientReport>;

const BY_NAME: ReadonlyMap<string, ClientReportKind> = new Map(CLIENT_REPORT_KINDS.map((k) => [k.kind, k]));

/** The kind a parsed report is. A report `ClientReport` accepted always names a registered kind (the union is built from the same
 *  list); a name with no entry is refused by name rather than read as some other kind. */
export function clientReportKind(name: string): ClientReportKind {
  const kind = BY_NAME.get(name);
  if (kind === undefined) throw new UnknownClientReportKind(name);
  return kind;
}

export class UnknownClientReportKind extends Error {
  override readonly name = "UnknownClientReportKind";
  constructor(kind: string) {
    super(`client reports: no registered kind ${JSON.stringify(kind.slice(0, 40))}`);
  }
}
