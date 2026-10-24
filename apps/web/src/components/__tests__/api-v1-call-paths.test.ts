// Every `apiV1(...)` call in a client component must address `/api/v1/…`.
//
// WHY THIS FILE EXISTS. `apiV1` (lib/client-v1.ts) is a thin wrapper around
// `fetch` that adds the envelope handling and PREPENDS NOTHING — the caller
// passes a full path. RS009's assign sheet called
// `/registrations/{id}/assign-targets` instead of
// `/api/v1/registrations/{id}/assign-targets`, so every open of the sheet
// 404'd in the browser.
//
// It shipped past a 5481-test suite, a clean tsc, a clean lint and both drift
// gates, because nothing in that stack can see it:
//
//  - unit tests never issue a real request;
//  - the route tests call the handler function directly, so the URL that
//    reaches Next's router is never exercised;
//  - `tsc` sees a template string, which is a string whatever it contains;
//  - the openapi gate compares the SPEC to the registry, not the client.
//
// It was found by clicking the button. This test is the cheap standing
// version of that click: a string check over the source, which cannot prove
// a route works but can prove no caller has forgotten the prefix again.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const COMPONENTS = join(process.cwd(), "src", "components");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" ? [] : sourceFiles(full);
    }
    return name.endsWith(".ts") || name.endsWith(".tsx") ? [full] : [];
  });
}

/** Every `apiV1(` call in a file, split by whether its first argument is a
 *  literal this scan can actually read.
 *
 *  The first version returned only the literals, so a call passing a
 *  VARIABLE produced no match at all and was invisible — a false green in
 *  the very gate written to prevent one. Three live callers do exactly that
 *  (v2/entrants-panel.tsx, v2/club-hub/team-squad-editor.tsx, and
 *  v2/board/use-board-actions.ts, whose `act(path, …)` wrapper hides all of
 *  its own call sites behind one indirection). Dynamic calls are now
 *  COUNTED and allow-listed rather than skipped, so a NEW one fails until
 *  someone checks it by hand. */
function apiV1Calls(src: string): { literals: string[]; dynamic: number } {
  // Comments are stripped FIRST. Without that, three files "matched"
  // because their prose mentions `apiV1(` — the scan counted an English
  // sentence as an unreviewed dynamic call and the allow-list would have
  // enshrined the noise.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const literals: string[] = [];
  let dynamic = 0;
  for (const m of code.matchAll(/\bapiV1\s*(?:<[^>]*>)?\s*\(\s*/g)) {
    const start = m.index + m[0].length;
    const ch = code[start];
    if (ch === "`" || ch === '"' || ch === "'") {
      const end = code.indexOf(ch, start + 1);
      literals.push(code.slice(start + 1, end === -1 ? start + 1 : end));
    } else {
      dynamic += 1;
    }
  }
  return { literals, dynamic };
}

function apiV1Targets(src: string): string[] {
  return apiV1Calls(src).literals;
}

/** Calls whose first argument is a variable, so the literal scan cannot read
 *  them. Each was traced BY HAND to an /api/v1 path; the note records what
 *  was found, because an allow-list without evidence is just a mute button.
 *
 *  A NEW dynamic call — or an extra one in a file already here — fails this
 *  gate until somebody does the same tracing. That is the point: the first
 *  version of this file simply skipped non-literals, which is a false green
 *  in the very gate written to prevent one. */
const HAND_CHECKED_DYNAMIC: Record<string, number> = {
  // `const url = cursor ? `/api/v1/persons?limit=100&cursor=…` : "/api/v1/persons"`
  "src/components/v2/entrants-panel.tsx": 1,
  // same person-pagination shape
  "src/components/v2/club-hub/team-squad-editor.tsx": 1,
  // `act(path, done, …)` — a wrapper whose own callers pass the literal
  "src/components/v2/board/use-board-actions.ts": 1,
  // `<T,>(url: string, options?) => apiV1<T>(url, …)` — same wrapper shape
  "src/components/v2/device-score-pad.tsx": 1,
  // `const path = `/api/v1/orgs/${orgId}/stream-targets/${t.id}`` — one literal
  // shared by the row's Remove (DELETE) and Rename/Replace (PATCH)
  "src/components/v2/stream-destinations-panel.tsx": 2,
  // Online chess (traced 2026-10-13, re-traced D16). (1) `makeArbiterSerial({ join, send })` (arbiter-watch.ts) — `join` POSTs
  // `/api/v1/fixtures/${id}/external-play/arbiter` with `{ side }` and `send` is `arbiterWatchRelease`'s DELETE of
  // `/api/v1/fixtures/${id}/external-play/arbiter/${participantId}` (both routes exist, POST and DELETE).
  // (2) `decisionRunner({ post: (path, body) => apiV1(path, …) })` — arbiter-decision.ts builds every path as
  // `/api/v1/fixtures/${id}/external-play/${tail}`, tail ∈ resync | video-override | flags/close | resolve (each a POST
  // route that exists). The check-in extension (traced 2026-10-19, spec 2026-10-09 §3.2.2) adds a third dynamic call and a tail to
  // (2): the board's "+5 min" goes through the same `decisionRunner` post, to `extendBoardPath` =
  // `/api/v1/fixtures/${id}/external-play/extend-checkin` (a POST route that exists, src/app/api/v1/fixtures/[id]/external-play/
  // extend-checkin); (3) `roundExtendRunner({ post: (path, body) => apiV1(path, …) })` (checkin-extend-ui.ts) posts only
  // `extendRoundPath` = `/api/v1/stages/${stageId}/extend-checkin` with `{ roundNo }` (a POST route that exists, src/app/api/v1/
  // stages/[id]/extend-checkin).
  "src/components/v2/arbiter-panel.tsx": 3,
  // `openRoundRunner({ post: (path, body) => apiV1(path, …) })` — open-round-state.ts posts only
  // `/api/v1/stages/${stageId}/open-round`, `/api/v1/fixtures/${id}/external-play/resend` and (the check-in extension, 2026-10-19)
  // `extendRoundPath` = `/api/v1/stages/${stageId}/extend-checkin` (all POST routes that exist). Still ONE dynamic call: the
  // extend press shares this `post`. The call moved out of open-round-control.tsx into the `useOpenRound` hook (arbiter round
  // column, Task 4), which OpenRoundControl and the arbiter column both use; the control no longer calls `apiV1` itself.
  "src/components/v2/desk/use-open-round.ts": 1,
  // The same `decisionRunner` post as the arbiter panel's (2) above.
  "src/components/v2/external-play-needs-result-queue.tsx": 1,
  // The arbiter round column's queue cards (Task 7): the same `decisionRunner({ post: (path, body) => apiV1(path, …) })` shape, and
  // the cards only ever call `runner.goOn`, which posts `/api/v1/fixtures/${id}/external-play/flags/close` with `{ ids }` (a POST
  // route that exists, src/app/api/v1/fixtures/[id]/external-play/flags/close) for a cancelled flagged board's "Mark as reviewed".
  "src/components/v2/arbiter/round-queue-cards.tsx": 1,
};

describe("apiV1 call paths", () => {
  const files = sourceFiles(COMPONENTS);

  it("finds the components that call apiV1 at all", () => {
    // Guards the guard: a scan that matches nothing passes every assertion
    // below and proves precisely nothing. If this ever drops to zero, the
    // regex has stopped matching, not the codebase stopped calling.
    const callers = files.filter((f) => apiV1Targets(readFileSync(f, "utf8")).length > 0);
    expect(callers.length).toBeGreaterThan(0);
  });

  it("addresses an absolute /api path in every call", () => {
    // The rule is "/api/", not "/api/v1/". `apiV1` is named for the envelope
    // it parses, not for a route prefix it enforces, and at least one caller
    // legitimately uses it against a non-v1 endpoint
    // (news/composer.tsx → /api/orgs/{id}/content-upload, which exists).
    // Requiring /api/v1 flagged that as a defect on this gate's first run.
    // The real bug class is a path with NO api prefix at all, which is what
    // RS009's sheet shipped.
    const offenders: string[] = [];
    for (const file of files) {
      for (const target of apiV1Targets(readFileSync(file, "utf8"))) {
        if (!target.startsWith("/api/")) {
          offenders.push(`${file.slice(file.indexOf("src/"))} → ${target}`);
        }
      }
    }
    expect(offenders, "apiV1 prepends nothing — pass the full /api/... path").toEqual([]);
  });

  it("has no UNREVIEWED dynamic call the literal scan cannot see", () => {
    // The false-green hole. A call whose first argument is a variable is
    // invisible to the literal scan above, so it is counted here instead and
    // must match a hand-checked entry. A new one — or an extra call in a
    // file already listed — fails until a human reads it.
    const found: Record<string, number> = {};
    for (const file of files) {
      const { dynamic } = apiV1Calls(readFileSync(file, "utf8"));
      if (dynamic > 0) found[file.slice(file.indexOf("src/"))] = dynamic;
    }
    expect(found).toEqual(HAND_CHECKED_DYNAMIC);
  });
});
