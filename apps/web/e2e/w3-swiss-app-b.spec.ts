import { test } from "@playwright/test";

// W3 Swiss app-B (plan 2026-10-31-w3-swiss-app-b.md). One describe per rule, each driven through the real desk, run only by
// the CI dispatch (`e2e.yml`) and judged as a WHOLE file, never with `-g`. Task 1 creates the scaffold; each later task
// adds its own describe beside this one. The Swiss helpers the app-A spec drives its desk with live in
// `./support/swiss-app-a-kit.ts` (moved there in Task 1, plan R20) and are imported from there. A task may instead give its
// describe a file of its own, `w3-swiss-tN.spec.ts` (Task 9 does: `w3-swiss-t9.spec.ts`), which keeps this file's shard small.
//
// Serial mode is set PER describe (`test.describe.configure({ mode: "serial" })` inside it), never file-wide: in a serial
// file the first red hides every later describe (AGENTS.md class 21), so a file-wide setting would hide the tasks that
// follow a red one.
test.describe("W3 Swiss app-B scaffold", () => {
  // Intentionally empty: Task 1 owns the file and the smoke suite beside it, not a flow. Later tasks add their describes.
});
