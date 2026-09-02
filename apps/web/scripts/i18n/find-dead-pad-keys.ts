// Detects dead `pad.*` dictionary keys — a key present in en/ui.json that is
// referenced by NEITHER a literal/template-matchable string in apps/web/src
// or apps/web/e2e, NOR scoring-vocab.ts's PAD_LABEL_KEYS (the engine's own
// declared pad-label emission surface, kept in sync with the eleven sport
// modules by `__tests__/scoring-vocab.test.ts`'s `declaredPadLabels()` gate).
//
// ScoringPad v3 R8 sweep, WS-E — see
// .superpowers/sdd/2026-09-01-scorepad-v3-r8-sweep/task-E-brief.md at the
// repo root for the trap this exists to avoid ("a key the engine can EMIT is
// NOT dead even if un-grepped"), spelled out in full at
// dead-pad-keys-lib.ts's own header alongside this file.
//
// Self-contained (no `@/` alias) so it runs standalone under plain node, the
// same pattern apps/web/src/server/migration/verify-court-migration.ts uses:
//
//   cd apps/web && node --experimental-strip-types scripts/i18n/find-dead-pad-keys.ts
//
// Exits 1 (and prints the dead list) if any dead key is found; exits 0
// otherwise. Also wired into apps/web's vitest suite —
// src/lib/__tests__/find-dead-pad-keys.test.ts imports this file's
// `dead-pad-keys-lib.ts` core directly — so a future dead key reds CI, not
// just a manual run of this script.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findDeadPadKeys } from "./dead-pad-keys-lib.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "../.."); // apps/web/scripts/i18n -> apps/web

const { padKeys, dead } = findDeadPadKeys(webRoot);

if (dead.length > 0) {
  console.error(`✗ ${dead.length} dead pad.* key(s) out of ${padKeys.length}:`);
  for (const k of dead) console.error(`    ${k}`);
  process.exit(1);
} else {
  console.log(`✓ 0 dead pad.* keys out of ${padKeys.length}.`);
}
