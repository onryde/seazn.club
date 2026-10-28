// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, v1, v1data, v1Multipart, setPlan } from "../harness.ts";

/**
 * P9.5 (D5b.5, "venues & courts" design doc, `usableWindows` algorithm) —
 * `court_hours`/`court_exceptions` (V367, P8's calendar editor) actually GATE
 * scheduling. Before this task the calendar existed and nothing scheduling-side
 * ever read it. Now the candidate-slot lattice (`buildGrid`'s `admits`), the
 * greedy placer (`slotFixtures` via `earliestOnCourt`) and `validateAssignments`
 * all resolve court availability through the ONE shared function
 * (`court-windows.ts`'s `usableWindows`) — the repo's recurring defect is
 * exactly the placer/verifier fork this replaces (`court_tag_mismatch` was the
 * worked example).
 *
 * Eight checks, each sized to fail on the ONE regression it guards rather than
 * passing in both the fixed and the broken state:
 *
 *   S1/S2 — a restrictive-hours court places the WHOLE board inside its
 *     window, and /validate agrees nothing is outside it afterward (placer/
 *     verifier parity — this is the one a re-fork would break).
 *   S3 — a `closed:true` exception is scoped to its OWN calendar date, never
 *     its weekday: the excepted date 422s NO_MATCHING_COURT (the sole court is
 *     closed the whole bounded run), the same weekday one week later does not.
 *   S4 — declared hours and the schedule's own session window can have an
 *     EMPTY intersection; the guard refuses 422 NO_MATCHING_COURT by CODE.
 *   S5 — a court with NO calendar rows at all is open the full civil day
 *     (calendars strictly SUBTRACT; omission must never make an org
 *     unschedulable).
 *   S6 — a fixture hand-placed (the normal PATCH/move path) outside its
 *     court's hours is reported by /validate but the write itself is never
 *     refused (P9.5's non-blocking carve-out beside `court_tag_mismatch`).
 *   S7 — two courts with DIFFERENT declared hours each bind only the fixtures
 *     actually placed on THEM — sized so neither court's capacity alone can
 *     hold the board, forcing both into use.
 *   S8 — a multi-day run resolves each calendar date against ITS OWN
 *     weekday's hours, never one weekday's hours smeared across every date —
 *     sized so total capacity exactly equals the fixture count, forcing all
 *     three dates into use with no other feasible split.
 *
 * Keyless, own fresh Pro org — no PLACEMENT_SERVICE_HOST gate. Every claim
 * here is about the shared `usableWindows` gate, which the GREEDY fallback
 * already exercises; proving the optimizer beats greedy is the placement-
 * cutover suites' job (above), a different claim entirely.
 */
/**
 * The per-file row cap is re-checked at COMMIT, not only at upload — and the
 * refusal names no number.
 *
 * Why this is in smoke and not left to e2e: `.github/workflows/e2e.yml` is
 * `push: branches: [main]` only, so a PR gets no e2e signal at all, and
 * `apps/web` vitest is `environment: "node"`. Smoke is the ONLY gate that runs
 * before these land. The commit-time cap is also the one with money attached:
 * an `imports` row carries no expiry, so a plan built on Pro stays committable
 * after the subscription lapses, and no UI is involved in that path.
 *
 * Deliberately NOT covering the wizard's preview behaviour — that is DOM-only
 * and belongs to `e2e/walkthrough/directory-import-paywall-preview.spec.ts`.
 */
export async function importCapAtCommitSuite(): Promise<void> {
  const s = newSession();
  const orgId = (await signIn(s, `delivered+smoke-import-cap-${tag}@resend.dev`)).org_id;
  await setPlan(orgId, "pro", s);

  // 51 rows: over community's cap, under Pro's (whose `import.bulk` row carries
  // a null int_value, which getLimit resolves to null = unlimited).
  const csv = ["Team", ...Array.from({ length: 51 }, (_, i) => `Cap Team ${i} ${tag}`)].join("\n");
  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), "cap.csv");
  const planned = await v1Multipart(s, "/api/v1/imports", form);
  check("import cap: 51 rows plan on Pro", planned.status === 201);
  const importId = v1data<{ importId: string }>(planned).importId;

  // The subscription lapses between plan and commit. setPlan busts the
  // entitlement cache, so the commit below resolves the NEW plan.
  await setPlan(orgId, "community", s);

  const committed = await v1(s, `/api/v1/imports/${importId}/commit`, "POST", undefined, {
    "Idempotency-Key": `smoke-import-cap-${tag}`,
  });
  check("import cap: commit after downgrade is refused 402", committed.status === 402);
  // The KEY, not merely a 402: 51 team rows also breach community's teams.max,
  // so without the commit-time row gate this still fails — later, and for a
  // different reason. Naming the key pins that the file is refused for its
  // SIZE, before anything is planned.
  const err =
    (committed.json.error as { feature_key?: string; reason?: string } | undefined) ?? {};
  check("import cap: refusal names import.bulk, not teams.max", err.feature_key === "import.bulk");
  // And the customer-visible sentence states no cap. It used to say "over 20
  // rows", which outlived the catalog's move to 50 and had organisers splitting
  // files that would have imported whole.
  check(
    "import cap: refusal reason restates no number",
    typeof err.reason === "string" && !/\d/.test(err.reason),
  );

  // Refused before a single write.
  const teams = await v1(s, "/api/v1/teams");
  const wrote = teams.status === 200 ? v1data<unknown[]>(teams).length : -1;
  check("import cap: the refused commit wrote no teams", wrote === 0);
}
