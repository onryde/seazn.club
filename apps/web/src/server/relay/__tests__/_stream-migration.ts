// The migration's text and table list, DERIVED from the file (never typed), shared by
// migration-shape.test.ts, rls-static.test.ts and telemetry.test.ts. A missing file reads as
// "" and [] — never a module-scope throw — so a red run before the migration exists still
// COLLECTS and fails on its assertions (a module-scope throw collects zero tests and reads green).
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DELTAS = resolve(import.meta.dirname, "../../../../../../db/migration/deltas");
const file = readdirSync(DELTAS).find((f) => /^V\d+__stream_sessions\.sql$/.test(f));

export const MIGRATION: string = file ? readFileSync(join(DELTAS, file), "utf8") : "";
export const STREAM_TABLES: string[] = [...MIGRATION.matchAll(/^create table (\w+)/gm)].map((m) => m[1]!);
