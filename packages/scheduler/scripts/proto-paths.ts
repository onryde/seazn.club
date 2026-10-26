// Where the scheduler's copy of the placement service's proto lives, in ONE place: the vendoring script writes here,
// gen-proto.ts reads from here, and the tests assert both against it. No side effects, so importing it is always safe.
import path from "node:path";
import { fileURLToPath } from "node:url";

/** packages/scheduler (this file is packages/scheduler/scripts/proto-paths.ts). */
export const PKG_ROOT: string = path.resolve(fileURLToPath(import.meta.url), "../..");
/** The directory protoc is pointed at. It holds exactly one file: the placement repo's `proto/scheduler.proto`. */
export const VENDORED_PROTO_DIR: string = path.join(PKG_ROOT, "proto");
export const VENDORED_PROTO: string = path.join(VENDORED_PROTO_DIR, "scheduler.proto");
/** The pin: the tag of the placement image CI pulls, which is the placement commit the copy came from. */
export const VENDORED_JSON: string = path.join(PKG_ROOT, "VENDORED.json");
