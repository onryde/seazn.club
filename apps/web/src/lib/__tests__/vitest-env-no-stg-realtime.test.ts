// Guard: the vitest process must never carry the .env.local Supabase URL /
// service-role key, or realtime.ts publishes live broadcasts to the stg
// project from every scoring/schedule suite (2026-11-03, ~370k/day).
// Exported values survive the drop in vitest.config.ts by design, so this
// only fails when the values came from the file.
import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const envFile = path.resolve(__dirname, "../../../../../.env.local");

function fileValue(key: string): string | undefined {
  if (!fs.existsSync(envFile)) return undefined;
  const m = fs.readFileSync(envFile, "utf8").match(new RegExp(`^${key}=["']?([^"'\\n]*)`, "m"));
  return m?.[1] || undefined;
}

describe("vitest env does not inherit stg Supabase from .env.local", () => {
  for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    it(`${key} is not the .env.local value`, () => {
      const fromFile = fileValue(key);
      // No file (CI) => nothing to leak; the assertion below is then trivially true.
      if (fromFile === undefined) return;
      // Boolean, never the values: a failing assertion would print the secret.
      expect(process.env[key] === fromFile).toBe(false);
    });
  }
});
