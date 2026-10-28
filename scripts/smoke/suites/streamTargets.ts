import { randomBytes } from "node:crypto";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, raw, check, html } from "../harness.ts";

/**
 * Streaming destinations over real HTTP (fixture-page stream T2b; spec §5.2, D2, D6): add a Twitch destination →
 * rename → replace its key → remove (an ARCHIVE) → remove again (404) → add the same key again (RESTORED: the same id)
 * → the same key once more while it is ACTIVE (A19, owner decision (a): `outcome: existing`, NOT renamed) → remove. First
 * the Streaming page itself renders its panel (B4 fix round 1, m10 — the page's only PR-time signal, since
 * e2e runs on a push to main). Runs on the shared Pro org and archives everything it creates, so no later suite sees a
 * destination. The stream key is never printed. SMOKE_ONLY=streamTargets runs it alone (SELECTABLE_SUITES).
 */
export async function streamTargetsSuite(admin: Session, orgId: string): Promise<void> {
  const base = `/api/v1/orgs/${orgId}/stream-targets`;
  const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const twitchKey = () => "live_1_" + Array.from(randomBytes(24), (b) => ALNUM[b % ALNUM.length]).join("");
  type Target = { id: string; label: string; keyHint: string | null; inUse: unknown; outcome?: unknown };
  const EXPECTED_STEPS = 9;
  let steps = 0;
  const step = (label: string, cond: boolean) => {
    check(`stream targets smoke: ${label}`, cond);
    steps++;
  };
  const done = () => {
    console.log(`stream targets smoke: ${steps} steps`);
    check(`stream targets smoke: all ${EXPECTED_STEPS} steps ran (ran ${steps})`, steps === EXPECTED_STEPS);
  };

  // Anchored on `="` (AGENTS.md): a bare testid probe also matches a serialised prop.
  const page = await html(admin, "/streaming");
  step(
    `GET /streaming renders the Streaming panel (got ${page.status})`,
    page.status === 200 && page.body.includes('data-testid="stream-destinations"'),
  );

  const key1 = twitchKey();
  const created = await raw(admin, base, "POST", { kind: "twitch", label: "smoke-tw", streamKey: key1 });
  const t = created.json.data as Target | undefined;
  step(
    `POST a Twitch destination → 201 with keyHint = the key's last 3, inUse null, outcome inserted (got ${created.status})`,
    created.status === 201 && t?.keyHint === key1.slice(-3) && t?.inUse === null && t?.outcome === "inserted",
  );
  if (!t?.id) return done();
  const one = `${base}/${t.id}`;

  const renamed = await raw(admin, one, "PATCH", { label: "smoke-tw-2" });
  step(
    `PATCH {label} → 200 with the new label (got ${renamed.status})`,
    renamed.status === 200 && (renamed.json.data as Target | undefined)?.label === "smoke-tw-2",
  );

  // A new key whose hint DIFFERS from the old one's, or the hint could not witness the replace.
  let key2 = twitchKey();
  while (key2.slice(-3) === key1.slice(-3)) key2 = twitchKey();
  const replaced = await raw(admin, one, "PATCH", { streamKey: key2 });
  step(
    `PATCH {streamKey} → 200 with the NEW key's hint (got ${replaced.status})`,
    replaced.status === 200 && (replaced.json.data as Target | undefined)?.keyHint === key2.slice(-3),
  );

  const removed = await raw(admin, one, "DELETE");
  step(
    `DELETE → 200 {removed: true} (got ${removed.status})`,
    removed.status === 200 && (removed.json.data as { removed?: unknown } | undefined)?.removed === true,
  );

  const again = await raw(admin, one, "DELETE");
  step(`DELETE a removed destination → 404 (got ${again.status})`, again.status === 404);

  const restored = await raw(admin, base, "POST", { kind: "twitch", label: "smoke-tw-back", streamKey: key2 });
  const back = restored.json.data as Target | undefined;
  step(
    `POST the same key again → 201 with the SAME id, the NEW label, outcome restored (never a second row) (got ${restored.status})`,
    restored.status === 201 && back?.id === t.id && back?.label === "smoke-tw-back" && back?.outcome === "restored",
  );

  const existing = await raw(admin, base, "POST", { kind: "twitch", label: "smoke-tw-renamed?", streamKey: key2 });
  const kept = existing.json.data as Target | undefined;
  step(
    `POST the key of an ACTIVE destination → 201, the SAME id, outcome existing, label NOT changed (A19) (got ${existing.status})`,
    existing.status === 201 && kept?.id === t.id && kept?.label === "smoke-tw-back" && kept?.outcome === "existing",
  );

  const cleanup = await raw(admin, one, "DELETE");
  step(`DELETE (cleanup) → 200 (got ${cleanup.status})`, cleanup.status === 200);
  done();
}
