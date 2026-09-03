// pack-hash.ts — a canonical content hash of a validated `Pack`.
//
// T4's `--keep` idempotence marker (lib/suites/tiny.ts) needs a way to tell
// "the pack that seeded this competition" from "a pack with different
// content" without re-reading the file the prior run used (a separate
// process, possibly on a separate checkout). A hash of the pack's own
// content, stamped into `competitions.branding` at seed time and compared
// against a freshly-computed hash on the next `--keep` run, is that
// mechanism (see tiny.ts's own header comment on `findExistingSeed`).
//
// No existing helper: `grep -a -rn "createHash" scripts/bench` returned
// nothing before this file. `node:crypto`'s sha256 is used directly rather
// than adding a dependency.
//
// CANONICAL means key order never changes the hash: every plain object's
// keys are sorted before stringifying. Array order is preserved deliberately
// — it is semantically significant in a pack (`stage.seeding`, `roster`
// order, `streams` order), unlike a JSON object's key order.
import { createHash } from "node:crypto";
import type { Pack } from "./pack-schema.ts";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      // `JSON.stringify` already drops `undefined`-valued keys on its own,
      // but dropping them here too means `canonicalize`'s OWN output is
      // stable independent of what serializes it.
      if (v !== undefined) sorted[key] = canonicalize(v);
    }
    return sorted;
  }
  return value;
}

/**
 * A stable sha256 hex digest of the pack's own content.
 *
 * Two `Pack` values that are the SAME content in a different key order hash
 * identically. Two that differ in ANY field — including `expected` and
 * `meta`, not just the seed-relevant sections — hash differently. That is
 * deliberate, not an oversight: `--keep`'s reuse guard would rather
 * OVER-invalidate (reseed on a pack edit that turns out to be comment-only)
 * than UNDER-invalidate (silently reuse stale seed data for pack content
 * that actually changed) — see AGENTS.md's "check both directions" rule on
 * idempotency guards.
 */
export function hashPack(pack: Pack): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(pack))).digest("hex");
}
