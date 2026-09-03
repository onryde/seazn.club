# ScoringPad v3 Phone Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Below 768px, every sport's fixture console shows the board first and the primary tap inside the first screen, with the console chrome folded into a strip and disclosures — and at 768px and up nothing moves.

**Architecture:** One DOM, branched with Tailwind v4 `max-md:` / `md:` classes; no media-query JS, no SSR branching. Two tiny pieces of state (Activity expanded, lineup disclosure open) toggled by phone-only buttons that are `md:hidden`. Exactly one control is duplicated (Hand over device); everything else is the same node re-laid.

**Tech Stack:** Next.js (this repo's version — read `node_modules/next/dist/docs/` before touching a page), React, Tailwind v4 (`@import "tailwindcss"`, `md` = 768px), vitest `environment: "node"` with `react-dom/server` `renderToStaticMarkup`, Playwright (seven-width `mobile-*`/`tablet-*` projects run only `e2e/mobile.spec.ts`), `scripts/smoke.ts`, `e2e/gallery.capture.ts`.

**Spec:** `docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md` — read it first; the plan argues from it. Two spec premises were found false while planning and are corrected here (see *Deviations from the spec* at the end).

## Global Constraints

- Worktree: `/Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile`, branch `feat/scorepad-v3-mobile-composition`. **Every command in this plan is prefixed `cd <worktree> &&` in the same shell call** — the shell cwd resets to the main checkout between calls. Never `git stash` here (shared stash stack).
- `pnpm` (`packageManager: pnpm@10.34.5`); node_modules already installed (`pnpm install --frozen-lockfile`, done 2026-09-02).
- Desktop untouched: never edit an existing class string except the one whitelisted change (`pad-host.tsx` root `space-y-3` → `flex flex-col gap-3`). Phone behaviour is added as `max-md:*` classes or as new elements carrying `md:hidden`.
- Tap floor 44px on every phone control. No horizontal page scroll at 320/360/375/390/430/768/834.
- Any new user-facing string → all four dictionaries `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, then `npm run i18n:gen-keys` (regenerates `apps/web/src/lib/i18n-keys.ts`; never edit that file by hand).
- Judge vitest green only from the JSON reporter: `numPassedTests`/`numTotalTests`, and confirm `.testResults[].name` paths resolve inside the worktree. `rtk` summaries lie (`PASS(0) FAIL(0)` on a collection failure). Lint via `rtk proxy npm run lint` and read `✖ N problems`. tsc via `npx tsc --noEmit -p apps/web; echo EXIT=$?`.
- Before every commit: `npm run openapi:gen && git status --porcelain` must show nothing new.
- No new issues/PRs filed. Fix inline unless the fix widens the blast radius past the task's files — then stop and report.
- Attribution on every commit:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01GDAMSXU8sAGKpzoQGdfB5e
  ```
- Scratch dir: set `PM="$SCRATCHPAD/pad-mobile"` where `$SCRATCHPAD` is the executing session's scratchpad directory; `mkdir -p "$PM"`. Never use bare `/tmp`.

---

## File structure

| File | Responsibility in this change |
|---|---|
| `apps/web/src/dictionaries/{en,es,fr,nl}/ui.json`, `apps/web/src/lib/i18n-keys.ts` (generated) | seven new keys (Task 1) |
| `apps/web/src/components/v2/scorepad/v3/activity.tsx` | `collapsible` prop: latest row only + phone toggle (Task 2) |
| `apps/web/src/components/v2/scorepad/v3/__tests__/activity-collapsible.test.tsx` | new, node render test (Task 2) |
| `apps/web/src/components/v2/scorepad/v3/pad-host.tsx` | root flex column, headline hidden on phone, phone `order` on context/recording/activity-slot (Task 3) |
| `apps/web/src/components/v2/scorepad/v3/scorebug.tsx` | halves padding, name clamp, hint one line, meta strip rail (Task 3) |
| `apps/web/src/components/v2/scorepad/v3/tile-grid.tsx` | taller tiles + 15px label on phone (Task 3) |
| `apps/web/src/components/v2/scorepad/v3/detail-dock.tsx` | chips 2-col grid on phone (Task 3) |
| `apps/web/src/components/v2/scorepad/v3/context-strip.tsx` | chips one per row on phone (Task 3) |
| `apps/web/src/components/v2/scorepad/v3/__tests__/phone-classes.test.tsx` | new, pins the phone classes exist on the right nodes (Task 3) |
| `apps/web/src/components/v2/phone-disclosure.tsx` | new, phone-only disclosure wrapper (Task 5) |
| `apps/web/src/components/v2/__tests__/phone-disclosure.test.tsx` | new (Task 5) |
| `apps/web/src/components/v2/fixture-console.tsx` | match strip, phone hand-over, details toggle, Scoring header hide, `collapsible`, lineup disclosures, spacing (Tasks 2, 4, 5) |
| `apps/web/src/components/v2/__tests__/fixture-console-authority-band.test.tsx` | new `describe` reusing its `consoleHtml()` (Task 4) |
| `apps/web/e2e/mobile.spec.ts` | `expectPhoneComposition()` + two call sites (Task 6) |
| `scripts/smoke.ts` | two probes (Task 7) |
| `docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md` | §3.7, §3.9, §6.4 amended (Task 8) |

Tasks 2, 4, 5 all edit `fixture-console.tsx` → run them **sequentially** (never in parallel worktrees).

---

### Task 0: Environment + baseline gallery (before any code change)

**Files:** none in the repo. Output: `$PM/env.sh`, `$PM/gallery-base/` (12 sports × 3 widths), `$PM/gallery-base/manifest.json`.

**Why first:** the after/before comparison in Task 8 needs a baseline captured from **this** worktree at `a7b823df3` (docs-only ahead of `main`), on a database this plan controls.

- [ ] **Step 1: Bring up a disposable Postgres and a prod server** — follow `~/.claude/skills/seazn-local-env/SKILL.md` (Skill tool: `seazn-local-env`) and `docs/runbooks/pad-gallery.md` §1 verbatim. The two traps that cost the most: `db:apply` alone is not a fresh schema (run `sync:sports` after it), and a `pg_ctl` "Address already in use" followed by a *successful* `createdb` means you created the DB on another session's server — confirm with `psql -h 127.0.0.1 -p <port> -U postgres -Atc "show data_directory"`, which must equal your `$PM/pg`.

Record what you chose:

```bash
cat > "$PM/env.sh" <<EOF
export PGPORT=<port> DBNAME=<dbname> WEBPORT=<port>
export DATABASE_URL="postgresql://postgres@127.0.0.1:\$PGPORT/\$DBNAME" DATABASE_SSL=disable
export PLAYWRIGHT_BASE="http://127.0.0.1:\$WEBPORT" E2E_PROD_TARGET=1
EOF
```

- [ ] **Step 2: Build and stage the standalone tree from the worktree ROOT** (runbook §1 steps 2–4; `next start` serves the wrong tree — stage `.next/standalone`, copy `static` and `public`, start detached with `nohup … & disown`). Confirm it is *your* server: `lsof -nP -iTCP:$WEBPORT -sTCP:LISTEN`.

- [ ] **Step 3: Capture the baseline, all sports, three widths**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile/apps/web && source "$PM/env.sh" && \
GALLERY_DIR="$PM/gallery-base" npx playwright test e2e/gallery.capture.ts --project=gallery \
  --reporter=json --output="$PM/gallery-base-run" > "$PM/gallery-base-run.json"; echo EXIT=$?
```

- [ ] **Step 4: Prove the harness did not run vacuous** (AGENTS.md failure class 10)

```bash
ls "$PM"/gallery-base/*/ | grep -c '\.png$'          # expect ≥ 94 (R8 sheet had 94 at 320 alone; 3 widths ⇒ more)
jq '{total:.stats.expected, failed:.stats.unexpected}' "$PM/gallery-base-run.json"
jq -r '.[] | select(.overflow320 != null) | "\(.sport) overflow320=\(.overflow320)"' "$PM/gallery-base/manifest.json" | head -3   # field name: read manifest.json's own keys first
```
Expected: PNG count ≥ 200, `failed: 0`, and `manifest.json` carries a per-sport 320 overflow measurement. Open two PNGs (any sport, `02-live-320` and `02-live-1280`) and confirm they differ and show a board — do not sign off on an empty page.

- [ ] **Step 5: Leave the DB and server running** — Task 8 reuses them. No commit.

---

### Task 1: Dictionary keys

**Files:**
- Modify: `apps/web/src/dictionaries/en/ui.json`, `…/es/ui.json`, `…/fr/ui.json`, `…/nl/ui.json` — insert beside the existing `"pad.activity.void"` line (≈ line 4585 in each; the files are in wave order, not alphabetical — keep the four files' insertion points identical)
- Generated: `apps/web/src/lib/i18n-keys.ts`

**Interfaces:**
- Produces the `DictionaryKey` members every later task calls through `msg()`/`t()`: `pad.activity.showAll`, `pad.activity.showLatest`, `console.phone.showDetails`, `console.phone.hideDetails`, `console.phone.lineup`, `lineup.phone.show`, `lineup.phone.hide`.

- [ ] **Step 1: Write the failing check** — the type is the test: a key that does not exist fails `tsc`.

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && \
grep -c '"pad.activity.showAll"' apps/web/src/lib/i18n-keys.ts   # expect 0
```

- [ ] **Step 2: Add the keys** (English first; the other three in the same position)

`en/ui.json`, after the `"pad.activity.void": "Void",` line:
```json
  "pad.activity.showAll": "Show all activity",
  "pad.activity.showLatest": "Show latest only",
  "console.phone.showDetails": "Show match details",
  "console.phone.hideDetails": "Hide match details",
  "console.phone.lineup": "Lineup",
  "lineup.phone.show": "Show lineup",
  "lineup.phone.hide": "Hide lineup",
```
`es/ui.json`:
```json
  "pad.activity.showAll": "Ver toda la actividad",
  "pad.activity.showLatest": "Ver solo la última",
  "console.phone.showDetails": "Ver detalles del partido",
  "console.phone.hideDetails": "Ocultar detalles del partido",
  "console.phone.lineup": "Alineación",
  "lineup.phone.show": "Ver alineación",
  "lineup.phone.hide": "Ocultar alineación",
```
`fr/ui.json`:
```json
  "pad.activity.showAll": "Afficher toute l’activité",
  "pad.activity.showLatest": "Afficher la dernière seulement",
  "console.phone.showDetails": "Afficher les détails du match",
  "console.phone.hideDetails": "Masquer les détails du match",
  "console.phone.lineup": "Composition",
  "lineup.phone.show": "Afficher la composition",
  "lineup.phone.hide": "Masquer la composition",
```
`nl/ui.json`:
```json
  "pad.activity.showAll": "Alle activiteit tonen",
  "pad.activity.showLatest": "Alleen laatste tonen",
  "console.phone.showDetails": "Wedstrijddetails tonen",
  "console.phone.hideDetails": "Wedstrijddetails verbergen",
  "console.phone.lineup": "Opstelling",
  "lineup.phone.show": "Opstelling tonen",
  "lineup.phone.hide": "Opstelling verbergen",
```

- [ ] **Step 3: Regenerate keys and run the dictionary suite**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && npm run i18n:gen-keys && \
grep -c '"pad.activity.showAll"\|"console.phone.lineup"\|"lineup.phone.hide"' apps/web/src/lib/i18n-keys.ts && \
cd apps/web && npx vitest run --reporter=json --outputFile="$PM/t1.json" src/lib/__tests__ ; \
jq '{total:.numTotalTests, passed:.numPassedTests, failed:.numFailedTests}' "$PM/t1.json"; \
jq -r '.testResults[0].name' "$PM/t1.json"
```
Expected: grep prints `3`; `failed: 0`, `total` > 0; the printed test path starts with the worktree path.

- [ ] **Step 4: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && npm run openapi:gen && git status --porcelain && \
git add apps/web/src/dictionaries apps/web/src/lib/i18n-keys.ts && \
git commit -m "i18n(scorepad): phone-composition disclosure labels in four locales

Seven keys for the phone-only controls the spec adds: the ledger's show-all
/ show-latest toggle, the match-details toggle, and the lineup disclosures.
No existing string changes.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GDAMSXU8sAGKpzoQGdfB5e"
```

---

### Task 2: `ActivityPanel` becomes collapsible on phones

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/v3/activity.tsx` — `ActivityPanelProps` (≈379–513), the function signature (≈574–590), the `<header>` (≈596–601), the row `<li>` (≈630–641)
- Modify: `apps/web/src/components/v2/fixture-console.tsx` — the `<ActivityPanel` mount (≈742) gains `collapsible`
- Create: `apps/web/src/components/v2/scorepad/v3/__tests__/activity-collapsible.test.tsx`

**Interfaces:**
- Consumes: Task 1 keys `pad.activity.showAll`, `pad.activity.showLatest`.
- Produces: `ActivityPanelProps.collapsible?: boolean`; DOM contract `data-role="v3-activity-toggle"` (phone-only button, `aria-expanded`), and every non-latest `li[data-role="v3-activity-row"]` carries `max-md:hidden` while collapsed. Task 6 asserts this in the browser.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/v2/scorepad/v3/__tests__/activity-collapsible.test.tsx
// Spec 2026-09-02-scorepad-v3-phone-composition-design.md §3.9. Rendered through
// react-dom/server — this workspace's vitest is `environment: "node"` (no DOM), so
// this pins WHICH nodes carry the phone class; whether the class takes EFFECT is
// proved by e2e/mobile.spec.ts `expectPhoneComposition` at seven widths.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityPanel, type ActivityEvent, type ActivityPanelProps } from "../activity";

function ev(over: Partial<ActivityEvent> & { id: string; seq: number }): ActivityEvent {
  return { type: "core.point", payload: {}, voids: null, ...over };
}
// Ascending on purpose: the component must pick the LATEST by seq, not index 0.
const THREE = [ev({ id: "a", seq: 1 }), ev({ id: "b", seq: 2 }), ev({ id: "c", seq: 3 })];
const t = ((key: string) => key) as unknown as ActivityPanelProps["t"];

function render(over: Partial<ActivityPanelProps>): string {
  return renderToStaticMarkup(
    <ActivityPanel
      events={THREE}
      ownEventIds={new Set()}
      deviceLinkId={null}
      personNames={{}}
      t={t}
      {...over}
    />,
  );
}
const liTags = (html: string) => html.match(/<li[^>]*data-role="v3-activity-row"[^>]*>/g) ?? [];
const eventId = (tag: string) => /data-event-id="([^"]+)"/.exec(tag)?.[1];

describe("ActivityPanel collapsible (phone)", () => {
  it("collapsed: only the latest-by-seq row is visible on phone; the rest carry max-md:hidden", () => {
    const tags = liTags(render({ collapsible: true }));
    expect(tags).toHaveLength(3);
    const visible = tags.filter((x) => !x.includes("max-md:hidden"));
    expect(visible).toHaveLength(1);
    expect(eventId(visible[0])).toBe("c");
  });
  it("renders the phone toggle, closed, only when there is more than one row", () => {
    const html = render({ collapsible: true });
    expect(html).toContain('data-role="v3-activity-toggle"');
    expect(html).toMatch(/data-role="v3-activity-toggle"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/data-role="v3-activity-toggle"[^>]*class="[^"]*\bmd:hidden\b/);
    expect(render({ collapsible: true, events: [THREE[0]] })).not.toContain('data-role="v3-activity-toggle"');
  });
  it("not collapsible (desktop console today, and every caller that omits it): no toggle, no hidden row", () => {
    const html = render({});
    expect(html).not.toContain('data-role="v3-activity-toggle"');
    expect(liTags(html).some((x) => x.includes("max-md:hidden"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it — expect red**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile/apps/web && npx vitest run --reporter=json --outputFile="$PM/t2.json" src/components/v2/scorepad/v3/__tests__/activity-collapsible.test.tsx; jq '{total:.numTotalTests, passed:.numPassedTests, failed:.numFailedTests}' "$PM/t2.json"
```
Expected: `total: 3, failed: 2` (the not-collapsible case may already pass) — or a TS error on `collapsible`; either is the red we want. `total: 0` means the file did not collect — fix the import before anything else.

- [ ] **Step 3: Implement**

In `activity.tsx`:

1. Import `useState` (the file currently imports only `type ReactNode` from "react"):
```ts
import { useState, type ReactNode } from "react";
```
2. Add to `ActivityPanelProps` (after `footer?: ReactNode;`):
```ts
  /** Phone composition (spec §3.9): below `md` show only the latest row until
   *  the scorer taps the toggle. At `md` and up the toggle is not rendered and
   *  no row is hidden — desktop markup is what it was. Omitted = today. */
  collapsible?: boolean;
```
3. Destructure `collapsible = false` in the signature, and inside the function body before `return`:
```ts
  const [expanded, setExpanded] = useState(false);
  const latestId = rows.reduce<ActivityEvent | null>(
    (best, row) => (best === null || row.event.seq > best.seq ? row.event : best),
    null,
  )?.id ?? null;
  const collapsed = collapsible && !expanded;
```
   (`rows` is the array the JSX already maps over; if its elements expose the event under a different name than `row.event`, use that name — read the map at ≈ line 630.)
4. Header — wrap the count so the toggle sits beside it:
```tsx
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-700">{t("pad.activity.heading")}</h2>
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-600 tabular-nums" data-role="v3-activity-count">
            {events.length}
          </span>
          {collapsible && rows.length > 1 && (
            <button
              type="button"
              data-role="v3-activity-toggle"
              aria-expanded={expanded}
              aria-label={t(expanded ? "pad.activity.showLatest" : "pad.activity.showAll")}
              onClick={() => setExpanded((v) => !v)}
              className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-400 md:hidden"
            >
              <span aria-hidden="true">{expanded ? "▴" : "▾"}</span>
            </button>
          )}
        </span>
      </header>
```
5. Row `<li>` className:
```tsx
                className={`flex items-start gap-3 border-l-[3px] px-4 py-2 ${stripe}${
                  collapsed && event.id !== latestId ? " max-md:hidden" : ""
                }`}
```
6. The caption line inside the row (the span that renders the time and "recorded by …" — find it between the `#seq` span and the Void button, ≈ 647–767): add `max-md:truncate` to that span and `max-md:min-w-0` to its flex parent so it reads on one line at phone widths.

In `fixture-console.tsx`, on the `<ActivityPanel` mount, add the prop line `collapsible` right after `authority`.

- [ ] **Step 4: Run — expect green; then mutate once**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile/apps/web && npx vitest run --reporter=json --outputFile="$PM/t2.json" src/components/v2/scorepad/v3/__tests__/; jq '{total:.numTotalTests, passed:.numPassedTests, failed:.numFailedTests}' "$PM/t2.json"
```
Expected: `failed: 0`, total = previous v3 `__tests__` total + 3. Then temporarily change `event.id !== latestId` to `true`, rerun → the first test must go red (`visible` length 0). Revert. If it stays green, the guard is decoration — stop and fix the test.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && npm run openapi:gen && git status --porcelain && \
git add apps/web/src/components/v2/scorepad/v3/activity.tsx apps/web/src/components/v2/scorepad/v3/__tests__/activity-collapsible.test.tsx apps/web/src/components/v2/fixture-console.tsx && \
git commit -m "feat(scorepad): ledger collapses to the latest row on phones

ActivityPanel gains \`collapsible\`: below md only the latest-by-seq row is
visible and a phone-only toggle reveals the rest; at md and up nothing is
rendered differently. The console passes it; the device-link page can opt in
later with the same prop. Spec §3.9.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GDAMSXU8sAGKpzoQGdfB5e"
```

---

### Task 3: Phone classes inside the pad (`v3/`)

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/v3/pad-host.tsx:1992-1994` (root), `:2064` (headline), `:2150` (context wrapper), `:2145` (recording wrapper), `:2276` (activity slot)
- Modify: `apps/web/src/components/v2/scorepad/v3/scorebug.tsx:150` (name), `:213` (hint), `:309` and `:319` (halves), `:328` (meta strip) and every strip-item `<span>` inside the `spec.strip.map` (the `led` branch at ≈345 and the plain branch after ≈361)
- Modify: `apps/web/src/components/v2/scorepad/v3/tile-grid.tsx:273-275`
- Modify: `apps/web/src/components/v2/scorepad/v3/detail-dock.tsx:434`, `:461`
- Modify: `apps/web/src/components/v2/scorepad/v3/context-strip.tsx:340`, `:368-370`, `:386-397`
- Create: `apps/web/src/components/v2/scorepad/v3/__tests__/phone-classes.test.tsx`

**Interfaces:**
- Produces: phone order inside `[data-role="pad-v3"]`: scorebug → ribbon → tiles → dock → swap/sheet → context → recording. Task 6 measures the first tap target against this.

Line numbers above are from a read on 2026-09-02; re-pin with `grep -an` before editing.

- [ ] **Step 1: Write the failing test** — pins that the classes exist on the *right* nodes (a node test cannot see the cascade; Task 6 does).

```tsx
// apps/web/src/components/v2/scorepad/v3/__tests__/phone-classes.test.tsx
// Spec §3.2–3.8. Node render only: proves WHICH nodes carry the phone classes.
// Effect at real widths: e2e/mobile.spec.ts `expectPhoneComposition`.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Scorebug } from "../scorebug";
import type { ScorebugSpec } from "../types";

const t = ((key: string) => key) as unknown as Parameters<typeof Scorebug>[0]["t"];
const spec: ScorebugSpec = {
  phase: "live",
  context: "Best of 3 · Game 1",
  halves: [
    { who: [{ name: "Gallery Badminton Home mtgyvvf39ppg", serving: true }], big: "1", tappable: true, hintKey: "pad.hint.rally", tapEvent: { type: "badminton.rally", payload: { side: "home" } } },
    { who: [{ name: "Gallery Badminton Away mtgyvvf39ppg" }], big: "0", tappable: true, hintKey: "pad.hint.rally", tapEvent: { type: "badminton.rally", payload: { side: "away" } } },
  ],
  strip: [
    { label: "Games", value: "0–0" },
    { label: "Serving", value: "Gallery Badminton Home mtgyvvf39ppg", accent: true },
    { value: "Left service court" },
  ],
} as ScorebugSpec; // if ScorebugSpec needs more fields, add them from types.ts — do not loosen the type

describe("scorebug phone classes", () => {
  const html = renderToStaticMarkup(<Scorebug spec={spec} t={t} />);
  it("both halves drop to px-2 on phones", () => {
    const halves = html.match(/<button[^>]*data-role="v3-scorebug-half"[^>]*>/g) ?? [];
    expect(halves).toHaveLength(2);
    for (const h of halves) expect(h).toMatch(/class="[^"]*\bmax-md:px-2\b/);
  });
  it("the name box clamps to two lines on phones (a pair stays readable)", () => {
    expect(html).toMatch(/class="[^"]*\bline-clamp-6\b[^"]*\bmax-md:line-clamp-2\b/);
  });
  it("the hint is one truncated line on phones", () => {
    expect(html).toMatch(/class="[^"]*\bmax-md:truncate\b[^"]*"[^>]*>pad\.hint\.rally</);
  });
  it("the meta strip is a non-wrapping rail on phones and every item refuses to shrink", () => {
    expect(html).toMatch(/class="[^"]*\bflex-wrap\b[^"]*\bmax-md:flex-nowrap\b[^"]*\bmax-md:overflow-x-auto\b/);
    expect((html.match(/max-md:shrink-0/g) ?? []).length).toBe(3); // one per strip item, no more
  });
});
```
(`ScorebugSpec`, `ScorebugHalf` field names: read `types.ts` — `who[].name`, `who[].serving`, `big`, `tappable`, `hintKey`, `tapEvent` are the names `scorebug.tsx` reads at 152–213 and 278–305. If a required field is missing, add it to the literal; never cast to `any`.)

- [ ] **Step 2: Run — expect red** (same vitest command as Task 2 Step 2 with this file; expect `failed: 4`, `total: 4`).

- [ ] **Step 3: Implement**

`pad-host.tsx`:
```tsx
      className="flex flex-col gap-3"          // was "space-y-3" — the ONE whitelisted desktop edit
```
```tsx
        <p data-role="v3-headline" className="rounded-xl bg-slate-900 px-4 py-2 text-center text-sm font-semibold text-white max-md:hidden">
```
```tsx
        <div data-role="v3-context" className="max-md:order-1">
```
```tsx
      <div data-role="v3-recording" className="max-md:order-2">
```
```tsx
      <div data-role="v3-activity-slot" className="max-md:order-3">
```
(Every other child keeps `order: 0`, so on phones the DOM order scorebug → ribbon → tiles → dock → swap → sheet holds, then context, then recording. On `md`+ `order` is unset everywhere: identical to today.)

`scorebug.tsx`:
- line 150 name box: append ` max-md:line-clamp-2`.
- line 213 hint: `className={\`text-[11px] font-medium ${NIGHT_TILE_CLASSES.creamTextMuted} max-md:block max-md:max-w-full max-md:truncate\`}`.
- line 309 (tappable half) and 319 (static half): append ` max-md:px-2 max-md:py-2` to the className.
- line 328 meta strip: append ` max-md:flex-nowrap max-md:justify-start max-md:gap-x-3 max-md:overflow-x-auto max-md:[scrollbar-width:none]`.
- Every strip-item `<span>` (the `led` branch and the plain branch): append ` max-md:shrink-0 max-md:whitespace-nowrap`.

`tile-grid.tsx`:
- line 273 button: append ` max-md:py-3`. (Do NOT touch the inline `style={{ minHeight }}` — it wins over any `min-h` class, so height is grown through padding.)
- line 275 label: `${tile.kind === "minor" ? "text-xs max-md:text-sm" : "text-sm max-md:text-[15px]"}`.

`detail-dock.tsx`:
- line 434 chips container: `className="flex flex-wrap gap-2 px-4 py-3 max-md:grid max-md:grid-cols-2"`.
- line 461 chip: append ` max-md:justify-center max-md:px-3` inside the template's first static segment.

`context-strip.tsx`:
- line 340 container: `className="flex flex-wrap gap-2 max-md:flex-col"`.
- lines 368 and 386 chip classNames: append ` max-md:w-full`. Lines 370 and 397 label spans: `className="break-words max-md:truncate"`.

- [ ] **Step 4: Run the whole v3 `__tests__` dir — expect green**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile/apps/web && npx vitest run --reporter=json --outputFile="$PM/t3.json" src/components/v2/scorepad/v3/__tests__/; jq '{total:.numTotalTests, passed:.numPassedTests, failed:.numFailedTests}' "$PM/t3.json"
```
Expected: `failed: 0`. `scorebug.test.ts` and `dock.test.ts` still green (they pin measurements, not class strings — if one goes red, read what it asserts before editing it).

- [ ] **Step 5: Grep the skins for hard-coded copies of any class you changed**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && grep -anE 'space-y-3"|line-clamp-6|grid-cols-4 gap-2' apps/web/src/components/v2/scorepad/v3/skins/*.tsx | head
```
Expected: no hits that render the scorebug/tile/dock chrome themselves (skins build specs; the chassis renders). Any hit → report it in the final message; do not edit skins in this task.

- [ ] **Step 6: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && npm run openapi:gen && git status --porcelain && \
git add apps/web/src/components/v2/scorepad/v3 && \
git commit -m "feat(scorepad): phone classes inside the pad — board first, names clamp, rail strip

Below md: the third score copy (headline) hides, halves lose padding, names
clamp to two lines, the hint is one line, the meta strip is a swipeable rail,
tiles grow through padding, dock chips sit in a two-column grid, context
chips take a row each, and context + recording chip move below the dock via
flex order. Root goes space-y-3 -> flex flex-col gap-3 (same 12px geometry) so
order can apply; every other desktop class string is untouched. Spec §3.2–3.8.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GDAMSXU8sAGKpzoQGdfB5e"
```

---

### Task 4: The match strip (console header) + phone hand-over + Scoring header

**Files:**
- Modify: `apps/web/src/components/v2/fixture-console.tsx:587` (root `space-y-6`), `:590-633` (header), `:667-693` (Scoring section + header row)
- Modify: `apps/web/src/components/v2/__tests__/fixture-console-authority-band.test.tsx` — new `describe` at the end, reusing its `consoleHtml(over)` helper (line 75)

**Interfaces:**
- Consumes: Task 1 keys `console.phone.showDetails/hideDetails`; existing `score.handOverDevice`.
- Produces DOM contract for Tasks 6/7: `data-role="device-handover-phone"` (button, `md:hidden`), `data-role="match-details-toggle"` (button, `md:hidden`, `aria-expanded`), desktop `data-role="device-handover"` now `max-md:hidden`, the Scoring `h2` `max-md:hidden`.

- [ ] **Step 1: Write the failing tests** — append to `fixture-console-authority-band.test.tsx`:

```tsx
describe("phone composition — the match strip (spec §3.1)", () => {
  it("offers Hand over device twice: the desktop button hides on phones, the phone icon hides on desktop", () => {
    const html = consoleHtml({ deviceHandover: true });
    expect(html).toMatch(/data-role="device-handover"[^>]*class="[^"]*\bmax-md:hidden\b/);
    expect(html).toMatch(/<button[^>]*data-role="device-handover-phone"[^>]*>/);
    expect(html).toMatch(/data-role="device-handover-phone"[^>]*class="[^"]*\bmd:hidden\b/);
    expect(html).toMatch(/data-role="device-handover-phone"[^>]*aria-label="[^"]+"/);
  });
  it("renders neither hand-over control when the page says this fixture may not be handed over", () => {
    const html = consoleHtml({ deviceHandover: false });
    expect(html).not.toContain('data-role="device-handover"');
    expect(html).not.toContain('data-role="device-handover-phone"');
  });
  it("ships a phone-only match-details toggle, closed, and hides the meta line behind it on phones", () => {
    const html = consoleHtml();
    expect(html).toMatch(/data-role="match-details-toggle"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/data-role="match-details-toggle"[^>]*class="[^"]*\bmd:hidden\b/);
    expect(html).toMatch(/class="[^"]*\bmax-md:hidden\b[^"]*"[^>]*>[^<]*score\.recordedBy|recorded by/);
  });
  it("hides the Scoring heading on phones — the strip is the heading there", () => {
    const html = consoleHtml();
    expect(html).toMatch(/<h2[^>]*class="[^"]*\bmax-md:hidden\b[^"]*"[^>]*>[^<]*(score\.scoring|Scoring)</);
  });
});
```
(`consoleHtml` renders with whatever `msg` the file mocks; the alternations above accept either the key or the English string — read the helper at 75–115 and keep the alternation that matches.)

- [ ] **Step 2: Run — expect red**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile/apps/web && npx vitest run --reporter=json --outputFile="$PM/t4.json" src/components/v2/__tests__/fixture-console-authority-band.test.tsx; jq '{total:.numTotalTests, passed:.numPassedTests, failed:.numFailedTests}' "$PM/t4.json"
```
Expected: `failed: 3` of the 4 new (the `deviceHandover: false` case passes already), existing cases green.

- [ ] **Step 3: Implement** in `fixture-console.tsx`

Add state beside `handoverOpen`:
```ts
  const [detailsOpen, setDetailsOpen] = useState(false);
```

Root wrapper (line 587): `<div className="space-y-6 max-md:space-y-3">`.

Header (replaces 590–633; every existing class kept, phone classes added):
```tsx
      {/* Scoreline header — on phones this IS the match strip (spec §3.1):
          names on one truncated line, status, a compact score, hand-over as an
          icon, and the round/venue/time line behind a details toggle. */}
      <header className="card p-5 max-md:p-3">
        <div className="flex flex-wrap items-center justify-between gap-3 max-md:flex-nowrap max-md:gap-2">
          <h1
            className={`text-lg font-semibold tracking-tight text-slate-900 max-md:min-w-0 max-md:flex-1 max-md:text-[13px] ${
              detailsOpen ? "" : "max-md:truncate"
            }`}
          >
            {homeName ?? resolveSlotLabel(fixture.home_slot_label ?? null, msg, "schedule.tbd")}{" "}
            <span className="text-slate-600">{msg("schedule.vs")}</span>{" "}
            {awayName ?? resolveSlotLabel(fixture.away_slot_label ?? null, msg, "schedule.tbd")}
          </h1>
          <span className={`badge ${STATUS_STYLE[live.status] ?? ""}`}>
            {scoreStatusLabel(msg, live.status)}
          </span>
          {deviceHandover && (
            <button
              type="button"
              data-role="device-handover-phone"
              aria-label={msg("score.handOverDevice")}
              aria-expanded={handoverOpen}
              onClick={() => setHandoverOpen((v) => !v)}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 md:hidden"
            >
              <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7h11M11 4l3 3-3 3M17 13H6M9 10l-3 3 3 3" />
              </svg>
            </button>
          )}
        </div>
        <div className="max-md:mt-1 max-md:flex max-md:items-center max-md:justify-between max-md:gap-2">
          {!suppressHeadline && (
            <p className="mt-2 font-mono text-2xl text-slate-800 max-md:mt-0 max-md:text-lg">
              {summary?.headline ?? "—"}
            </p>
          )}
          <button
            type="button"
            data-role="match-details-toggle"
            aria-expanded={detailsOpen}
            aria-label={msg(detailsOpen ? "console.phone.hideDetails" : "console.phone.showDetails")}
            onClick={() => setDetailsOpen((v) => !v)}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 md:hidden"
          >
            <span aria-hidden="true">{detailsOpen ? "▴" : "▾"}</span>
          </button>
        </div>
        {decidedLine && <p className="mt-1 text-sm font-medium text-slate-700">{decidedLine}</p>}
        <p className={`mt-1 text-xs text-slate-600 ${detailsOpen ? "" : "max-md:hidden"}`}>
          {msg("schedule.round", { n: fixture.round_no })}
          {fixture.scheduled_at ? (
            <>
              {" · "}
              <ClientTime value={fixture.scheduled_at} mode="datetime" tz={fixture.scheduled_tz} showZone />
            </>
          ) : (
            ""
          )}
          {fixture.venue_name ? ` · ${fixture.venue_name}` : ""}
          {fixture.court_name ? ` · ${fixture.court_name}` : ""}
          {` · ${msg("score.recordedBy", { scorer: sport.scorerLabel.toLowerCase() })}`}
        </p>
      </header>
```
Keep the three existing explanatory comments (R3.5 contrast notes) where they were — they document the colour choices; only the code above changes.

Scoring section (667–693):
```tsx
        <section className="card p-5 max-md:p-3" data-role="console-scoring">
          <div className={`mb-3 flex flex-wrap items-center justify-between gap-2 ${started ? "max-md:hidden" : ""}`}>
            <h2 className="text-sm font-semibold text-slate-700 max-md:hidden">{msg("score.scoring")}</h2>
            <div className="flex flex-wrap items-center gap-2">
              {deviceHandover && (
                <button
                  type="button"
                  data-role="device-handover"
                  aria-expanded={handoverOpen}
                  onClick={() => setHandoverOpen((v) => !v)}
                  className="btn btn-ghost min-h-11 max-md:hidden"
                >
                  {msg("score.handOverDevice")}
                </button>
              )}
              {!started && (
                … unchanged Start match button …
              )}
            </div>
          </div>
```
(The row hides on phones only once the match has started — before that it still carries *Start match*, which must stay reachable.)

- [ ] **Step 4: Run — expect green; run the sibling console tests too**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile/apps/web && npx vitest run --reporter=json --outputFile="$PM/t4.json" src/components/v2/__tests__/; jq '{total:.numTotalTests, passed:.numPassedTests, failed:.numFailedTests}' "$PM/t4.json"
```
Expected: `failed: 0`. If `history-panel-contrast.test.tsx` or any test pinning the header's markup goes red, read its assertion: a test that pins the OLD DOM shape is updated to the new one only if the assertion is about shape; a test that pins a colour or ratio must keep passing untouched.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && npm run openapi:gen && git status --porcelain && \
git add apps/web/src/components/v2/fixture-console.tsx apps/web/src/components/v2/__tests__/fixture-console-authority-band.test.tsx && \
git commit -m "feat(console): the fixture header is a match strip on phones

Below md the header re-lays as one truncated names line, the status badge,
a compact mono score, a 44px hand-over icon and a details toggle that
reveals the round/venue/time line; the Scoring heading and the desktop
hand-over button hide there. Hand over device is the one control that now
exists twice, one hidden per width, same accessible name. Spec §3.1, §2.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GDAMSXU8sAGKpzoQGdfB5e"
```

---

### Task 5: `PhoneDisclosure` + lineups fold on phones

**Files:**
- Create: `apps/web/src/components/v2/phone-disclosure.tsx`
- Create: `apps/web/src/components/v2/__tests__/phone-disclosure.test.tsx`
- Modify: `apps/web/src/components/v2/fixture-console.tsx:820-865` (both lineup/roster maps)

**Interfaces:**
- Consumes: Task 1 keys `console.phone.lineup`, `lineup.phone.show`, `lineup.phone.hide`.
- Produces: `PhoneDisclosure({ summary, aside?, showLabel, hideLabel, children })`; DOM `data-role="phone-disclosure"` with `data-open`, toggle `data-role="phone-disclosure-toggle"` (`md:hidden`, `aria-expanded`), body wrapper carrying `max-md:hidden` while closed.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/components/v2/__tests__/phone-disclosure.test.tsx — spec §3.10
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PhoneDisclosure } from "../phone-disclosure";

const html = renderToStaticMarkup(
  <PhoneDisclosure summary="Home Gallery Badminton" aside="Lineup" showLabel="Show lineup" hideLabel="Hide lineup">
    <p data-role="body">the editor</p>
  </PhoneDisclosure>,
);

describe("PhoneDisclosure", () => {
  it("renders a phone-only toggle, closed, named by showLabel", () => {
    expect(html).toMatch(/<button[^>]*data-role="phone-disclosure-toggle"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/data-role="phone-disclosure-toggle"[^>]*aria-label="Show lineup"/);
    expect(html).toMatch(/data-role="phone-disclosure-toggle"[^>]*class="[^"]*\bmd:hidden\b/);
  });
  it("hides the body on phones while closed and never on desktop", () => {
    expect(html).toMatch(/<div class="max-md:hidden"><p data-role="body">the editor<\/p><\/div>/);
  });
  it("shows the summary and aside in the toggle", () => {
    expect(html).toContain("Home Gallery Badminton");
    expect(html).toContain("Lineup");
  });
});
```

- [ ] **Step 2: Run — expect red** (module not found).

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/components/v2/phone-disclosure.tsx
"use client";
import { useState, type ReactNode } from "react";

export interface PhoneDisclosureProps {
  /** The card's own title, verbatim — what the row reads as on a phone. */
  summary: ReactNode;
  /** Right-aligned fact in the row, e.g. the word "Lineup". */
  aside?: ReactNode;
  showLabel: string;
  hideLabel: string;
  children: ReactNode;
}

/** Phone-only disclosure (spec 2026-09-02-scorepad-v3-phone-composition §3.10).
 *  Below `md` the body is hidden until the row is tapped; at `md` and up the
 *  row is not rendered (`md:hidden`) and the body carries no hiding class, so
 *  desktop is a plain wrapper around what it always rendered. */
export function PhoneDisclosure({ summary, aside, showLabel, hideLabel, children }: PhoneDisclosureProps) {
  const [open, setOpen] = useState(false);
  return (
    <div data-role="phone-disclosure" data-open={open}>
      <button
        type="button"
        data-role="phone-disclosure-toggle"
        aria-expanded={open}
        aria-label={open ? hideLabel : showLabel}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-4 text-left transition-colors hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400 md:hidden"
      >
        <span className="min-w-0 truncate text-sm font-semibold text-slate-900">{summary}</span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-slate-600">
          {aside}
          <span aria-hidden="true">{open ? "▴" : "▾"}</span>
        </span>
      </button>
      <div className={open ? "" : "max-md:hidden"}>{children}</div>
    </div>
  );
}
```
Note the closed body renders exactly `<div class="max-md:hidden">` — the test pins that literal; when open it renders `<div class="">`. Keep it that way (no extra classes on this wrapper) so the desktop wrapper stays a bare block.

In `fixture-console.tsx`, import `{ PhoneDisclosure } from "@/components/v2/phone-disclosure"` and wrap **both** maps' elements:
```tsx
            return (
              <PhoneDisclosure
                key={s.id}
                summary={entrantDisplayName(s)}
                aside={msg("console.phone.lineup")}
                showLabel={msg("lineup.phone.show")}
                hideLabel={msg("lineup.phone.hide")}
              >
                <LineupEditor
                  fixtureId={fixture.id}
                  side={{ ...s, name: entrantDisplayName(s) }}
                  positionGroups={sport.positionGroups}
                  roles={sport.roles}
                  lineupSize={sport.lineupSize}
                  canEdit={canEdit && live.status === "scheduled"}
                  onSaved={() => router.refresh()}
                  availability={availability}
                />
              </PhoneDisclosure>
            );
```
and the same wrapper around `<AvailabilityRoster … />` in the second map (the `key` moves to the wrapper).

- [ ] **Step 4: Run — expect green** (`src/components/v2/__tests__/` as in Task 4 Step 4; `fixture-console-lineup-gate.test.tsx` must stay green — it counts editors/rosters by markup, and the wrapper adds no editor).

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && npm run openapi:gen && git status --porcelain && \
git add apps/web/src/components/v2/phone-disclosure.tsx apps/web/src/components/v2/__tests__/phone-disclosure.test.tsx apps/web/src/components/v2/fixture-console.tsx && \
git commit -m "feat(console): lineups fold to one row each on phones

PhoneDisclosure: a phone-only summary row (md:hidden) over a body that is
max-md:hidden while closed; on desktop it is a bare wrapper. Both lineup
editors and both availability rosters are wrapped. Spec §3.10.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GDAMSXU8sAGKpzoQGdfB5e"
```

---

### Task 6: Seven-width e2e — the composition, measured in a browser

**Files:**
- Modify: `apps/web/e2e/mobile.spec.ts` — add `expectPhoneComposition` after the `projectViewport` helper (≈ line 44); call it at the END of the existing tests titled exactly `badminton v3 pad: both scoring halves and the Set-score tile hold the 44px floor, no horizontal scroll` (`"S"`) and `cricket v3 pad: tiles + over-summary sheet + context strip hold the 44px floor, no horizontal scroll` (`"T"`).

**Interfaces:**
- Consumes DOM contracts from Tasks 2–5: `v3-activity-toggle`, `v3-activity-row`, `device-handover`, `device-handover-phone`, `match-details-toggle`, `phone-disclosure-toggle`, `console-scoring`, `v3-headline`, `v3-scorebug-half`, `v3-tiles`.

- [ ] **Step 1: Add the helper**

```ts
/** Phone composition (spec 2026-09-02-scorepad-v3-phone-composition-design.md §6.2).
 *  Prints the visible control list so a reviewer can diff phone vs desktop by
 *  eye, then asserts the composition — not the box sizes — at this project's
 *  width. `model` "S": the scorebug halves are the rally buttons; "T": the
 *  first tile is the primary tap. */
async function expectPhoneComposition(page: Page, model: "S" | "T"): Promise<void> {
  const vp = projectViewport();
  if (!vp) return;
  const phone = vp.width < 768;
  await page.evaluate(() => window.scrollTo(0, 0));
  const controls = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('button, a[href], select, [role="button"]'))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && cs.visibility !== "hidden";
      })
      .map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60)),
  );
  console.log(`[phone-composition ${vp.width}x${vp.height}] ${controls.length} visible controls:\n  ${controls.join("\n  ")}`);

  const deskHandover = page.locator('[data-role="device-handover"]');
  const phoneHandover = page.locator('[data-role="device-handover-phone"]');
  const handoverOffered = (await deskHandover.count()) > 0;
  const detailsToggle = page.locator('[data-role="match-details-toggle"]');
  const scoringHeading = page.locator('[data-role="console-scoring"] h2');
  const activityToggle = page.locator('[data-role="v3-activity-toggle"]');
  const rows = page.locator('[data-role="v3-activity-row"]');
  const rowCount = await rows.count();

  if (phone) {
    if (handoverOffered) {
      await expect(phoneHandover).toBeVisible();
      await expect(deskHandover).toBeHidden();
    }
    await expect(detailsToggle).toBeVisible();
    await expect(scoringHeading).toBeHidden();
    await expect(page.locator('[data-role="v3-headline"]')).toBeHidden();

    // The primary tap sits inside the first screen, with the page at the top.
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const target =
      model === "S"
        ? page.locator('button[data-role="v3-scorebug-half"]').first()
        : page.locator('[data-role="v3-tiles"] button[data-tile-id]').first();
    const box = await target.boundingBox();
    expect(box, "primary tap target must render").not.toBeNull();
    expect(
      box!.y + box!.height,
      `primary tap target bottom edge (${Math.round(box!.y + box!.height)}px) must sit inside the ${vp.height}px first screen`,
    ).toBeLessThanOrEqual(vp.height);
    // Nothing overlays it at its centre — a 44px box under a sheet is still a miss.
    expect(
      await target.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return at !== null && (at === el || el.contains(at));
      }),
    ).toBe(true);

    // Ledger: latest only until the toggle is tapped; every row after.
    if (rowCount > 1) {
      await expect(activityToggle).toBeVisible();
      expect(await rows.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetHeight > 0).length)).toBe(1);
      await activityToggle.click();
      expect(await rows.evaluateAll((els) => els.filter((e) => (e as HTMLElement).offsetHeight > 0).length)).toBe(rowCount);
      await activityToggle.click();
    }
    // Lineup disclosures: rows visible, editors folded.
    const disclosures = page.locator('[data-role="phone-disclosure-toggle"]');
    for (let i = 0; i < (await disclosures.count()); i++) await expect(disclosures.nth(i)).toBeVisible();
  } else {
    if (handoverOffered) {
      await expect(deskHandover).toBeVisible();
      await expect(phoneHandover).toBeHidden();
    }
    await expect(detailsToggle).toBeHidden();
    await expect(scoringHeading).toBeVisible();
    await expect(activityToggle).toBeHidden();
    for (const el of await page.locator('[data-role="phone-disclosure-toggle"]').all()) await expect(el).toBeHidden();
  }
  await expectNoHorizontalScroll(page);
}
```

- [ ] **Step 2: Call it** — as the last statement of each of the two named tests: `await expectPhoneComposition(page, "S");` (badminton) and `await expectPhoneComposition(page, "T");` (cricket). Read each test first: if the test ends with a sheet open, close it before the call (the helper measures the resting board). Do not change either test's existing assertions.

- [ ] **Step 3: Run both tests across all seven projects, against the prod server from Task 0** — rebuild first because Tasks 2–5 changed the app:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && rm -rf apps/web/.next && npm run build && \
# re-stage standalone + restart the detached server exactly as in Task 0 Step 2, then:
cd apps/web && source "$PM/env.sh" && \
npx playwright test e2e/mobile.spec.ts -g "badminton v3 pad|cricket v3 pad|setup:" \
  --project=mobile-320 --project=mobile-se --project=mobile-360 --project=mobile-14 --project=mobile-430 --project=tablet-768 --project=tablet-834 \
  --reporter=json > "$PM/e2e-mobile.json"; echo EXIT=$?; \
jq '{expected:.stats.expected, unexpected:.stats.unexpected, skipped:.stats.skipped}' "$PM/e2e-mobile.json"
```
`mobile.spec.ts` is `serial`; the `-g` includes the file's own `setup:` test so the seeded fixtures exist — read the file's first `test(` titles and widen `-g` if the badminton/cricket tests depend on an earlier titled test. Expected: `unexpected: 0`, and the console log shows two different control lists per width (phone lists carry `Show match details`, desktop lists carry `Hand over device` as text). Paste the 320 and 1280 lists into the final message.

- [ ] **Step 4: If — and only if — the cricket first-tap assertion fails at `mobile-320` alone**, apply the documented fallback: in `pad-host.tsx` add `max-md:order-1` to the ribbon wrapper (`data-role="v3-ribbon"`, ≈ line 2121) so the ribbon follows the tiles on phones, rerun Step 3, and record the measured before/after `px` in the commit message. Any failure at another width or on badminton is a defect to fix, not a budget to widen.

- [ ] **Step 5: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && git add apps/web/e2e/mobile.spec.ts apps/web/src/components/v2/scorepad/v3/pad-host.tsx && \
git commit -m "test(e2e): the phone composition, measured at seven widths

expectPhoneComposition prints the visible control list and asserts: on
phones the primary tap sits inside the first screen with the page at rest,
nothing overlays its centre, the ledger shows the latest row until toggled,
hand-over is the phone icon and the Scoring heading is gone; on tablets and
desktop the inverse. Called from the badminton (rally) and cricket (keypad)
v3 pad tests.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GDAMSXU8sAGKpzoQGdfB5e"
```

---

### Task 7: Smoke probe

**Files:**
- Modify: `scripts/smoke.ts` — next to the existing probe that fetches a fixture console page (find it: `grep -an "/f/" scripts/smoke.ts | head`; it will be an `html(session, \`…/f/\${no}\`)` call with `check(` lines after it).

- [ ] **Step 1: Add two checks** immediately after that probe's existing `check(` calls (reuse its response variable name — below it is called `fx`):

```ts
  // Phone composition (spec 2026-09-02-scorepad-v3-phone-composition §6.3):
  // anchored on `="` — React serialises an omitted prop as "$undefined", so a
  // bare data-role probe would pass in both states.
  check(
    "fixture console: phone match-details toggle is in the markup",
    fx.status === 200 && fx.body.includes('data-role="match-details-toggle"'),
  );
  check(
    "fixture console: phone hand-over icon ships beside the desktop button",
    !fx.body.includes('data-role="device-handover"') || fx.body.includes('data-role="device-handover-phone"'),
  );
```

- [ ] **Step 2: Run smoke against the Task 0 server**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && source "$PM/env.sh" && SMOKE_BASE="$PLAYWRIGHT_BASE" node --experimental-strip-types scripts/smoke.ts 2>&1 | tee "$PM/smoke.log" | grep -E "fixture console: phone|^FAIL|passed|failed" | tail -20; echo EXIT=${PIPESTATUS[0]}
```
Expected: both new lines print `PASS`; no `FAIL` lines; exit 0. Temporarily change `match-details-toggle` to `match-details-togglx` in the probe and rerun → the first line must print `FAIL`. Revert.

- [ ] **Step 3: Commit**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && git add scripts/smoke.ts && \
git commit -m "test(smoke): the phone strip's controls are in the fixture console markup

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GDAMSXU8sAGKpzoQGdfB5e"
```

---

### Task 8: Gates, the desktop-unchanged proof, gallery, review, sign-off

**Files:**
- Modify: `docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md` (§3.7, §3.9, §6.4 — see *Deviations* below)
- Output: `$PM/gallery-after/`, `$PM/pixel-recheck/`, `$PM/class-audit.txt`, `$PM/gates.txt`

- [ ] **Step 1: Static gates**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && { npx tsc --noEmit -p apps/web; echo "TSC EXIT=$?"; rtk proxy npm run lint 2>&1 | grep -E "✖|problems|clean" ; npm run openapi:gen && git status --porcelain; } | tee "$PM/gates.txt"
```
Expected: `TSC EXIT=0`, `✖ 0 problems` (or no ✖ line), empty porcelain.

- [ ] **Step 2: Class audit — the desktop-unchanged proof, mechanically**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && git diff main -- apps/web/src \
  | grep -E '^\+' | grep -vE '^\+\+\+' | grep -oE '(className|class)=(\{`|")[^`"]*' \
  | tr ' ' '\n' | grep -vE '^(className|class)=' | grep -vE '^(max-md:|md:)' | sort | uniq -c | sort -rn | tee "$PM/class-audit.txt"
```
Every surviving token must be one of: a class on a NEW element (`device-handover-phone`, `match-details-toggle`, `v3-activity-toggle`, `phone-disclosure*`, the count wrapper span, the header's new inner `div`), or `flex`/`flex-col`/`gap-3` from the whitelisted root change, or a class that was already on the line and merely re-printed by the diff. Anything else is a desktop edit — revert it. Paste the list in the final message.

- [ ] **Step 3: Unit gate across the touched dirs**

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile/apps/web && npx vitest run --reporter=json --outputFile="$PM/t8.json" src/components/v2 src/lib; jq '{total:.numTotalTests, passed:.numPassedTests, failed:.numFailedTests, first:.testResults[0].name}' "$PM/t8.json"
```
Expected: `failed: 0`; `first` inside the worktree.

- [ ] **Step 4: After-gallery, all sports, three widths** (server already rebuilt in Task 6 Step 3; if Task 7 changed nothing in `apps/web` it is current):

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile/apps/web && source "$PM/env.sh" && \
GALLERY_DIR="$PM/gallery-after" npx playwright test e2e/gallery.capture.ts --project=gallery --reporter=json --output="$PM/gallery-after-run" > "$PM/gallery-after-run.json"; echo EXIT=$?; \
ls "$PM"/gallery-after/*/ | grep -c '\.png$'; jq '{failed:.stats.unexpected}' "$PM/gallery-after-run.json"
```
Expected: same PNG count as the baseline, `failed: 0`.

- [ ] **Step 5: Pixel re-check on the SAME seeded fixtures** — the gallery seeds random-tagged fixtures per run, so base vs after PNGs are not byte-comparable. Instead re-screenshot the baseline's own fixture URLs on the new build at 768 and 1280:

```bash
jq -r '.[0] | keys' "$PM/gallery-base/manifest.json"     # find the field that holds the captured page URL/path
```
If the manifest carries a URL or path per screen, write `$PM/pixel-recheck.ts`:
```ts
// Re-screenshot the baseline's fixture pages on the CURRENT build at 768/1280
// and byte-compare against the baseline PNGs. Same DB, same seeded rows, same
// stored timestamps — so anything that differs is layout.
import { chromium } from "@playwright/test";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
const PM = process.env.PM!, BASE = process.env.PLAYWRIGHT_BASE!;
const manifest = JSON.parse(readFileSync(`${PM}/gallery-base/manifest.json`, "utf8")) as Array<Record<string, string>>;
const urlOf = (m: Record<string, string>) => m.url ?? m.path ?? m.href;   // whichever key the manifest uses
const heights: Record<number, number> = { 768: 1024, 1280: 800 };
mkdirSync(`${PM}/pixel-recheck`, { recursive: true });
const browser = await chromium.launch();
const ctx = await browser.newContext({ storageState: "playwright/.auth/user.json" }); // the gallery's own auth state — read gallery.capture.ts for the exact path
let same = 0, diff = 0;
for (const m of manifest) {
  for (const w of [768, 1280]) {
    const base = `${PM}/gallery-base/${m.sport}/${m.state}-${w}.png`;
    if (!existsSync(base) || !urlOf(m)) continue;
    const page = await ctx.newPage(); await page.setViewportSize({ width: w, height: heights[w] });
    await page.goto(new URL(urlOf(m), BASE).toString(), { waitUntil: "networkidle" });
    const out = `${PM}/pixel-recheck/${m.sport}-${m.state}-${w}.png`;
    await page.screenshot({ path: out, fullPage: true }); await page.close();
    try { execFileSync("cmp", ["-s", base, out]); same++; console.log(`SAME ${m.sport}/${m.state}-${w}`); }
    catch { diff++; console.log(`DIFF ${m.sport}/${m.state}-${w}`); }
  }
}
console.log(`same=${same} diff=${diff}`); await browser.close();
```
Run: `cd apps/web && source "$PM/env.sh" && PM="$PM" node --experimental-strip-types "$PM/pixel-recheck.ts" | tee "$PM/pixel-recheck.log"`. Expected: `diff=0` for 768/1280 — or a DIFF list whose every entry, opened side by side, shows a difference in dynamic content (a clock, a countdown), never in layout. Record what you saw per DIFF entry. If the manifest has no URL field, say so in the final message and fall back to opening base vs after PNGs for three sports (badminton, cricket, football) at 768 and 1280 side by side and writing down, per pair, what differs.

- [ ] **Step 6: 320 must differ** — the change is live, not suppressed:

```bash
for f in "$PM"/gallery-base/*/02-live-320.png; do s=$(basename "$(dirname "$f")"); cmp -s "$f" "$PM/gallery-after/$s/02-live-320.png" && echo "UNCHANGED $s" || echo "changed $s"; done
```
Expected: every sport `changed`. (Names differ per run too, so this is a weak check on its own — the strong one is Step 7.)

- [ ] **Step 7: Look, and write down what you saw** — open `gallery-after/<sport>/02-live-320.png` and `04-dock-320.png` for ALL twelve sports and `02-live-1280.png` for three. For each 320 image record one line: first tap target inside the first 568px (yes/no, measured from the image), names readable, no clipped control. Put the table in `$PM/verdicts.md`.

- [ ] **Step 8: Amend the spec** — §3.7: no Cancel/Back exists (dismiss is the 44px X); §3.9: the footer (Void last entry, Ledger verified, Download audit) stays visible on phones — only rows fold; §3.5: context chips move BELOW the dock on phones (order-1) so keypad sports reach the first tile inside the first screen; §6.4: byte-identical across two gallery runs is impossible (random-tagged seeds) — replaced by the class audit + same-URL pixel re-check. Commit:

```bash
cd /Users/ashokhein/github/seazn.club/.claude/worktrees/pad-mobile && git add docs/superpowers/specs/2026-09-02-scorepad-v3-phone-composition-design.md && \
git commit -m "docs(scorepad): phone-composition spec — three premises corrected by reading the tree

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GDAMSXU8sAGKpzoQGdfB5e"
```

- [ ] **Step 9: Review pass** — dispatch a `reviewer` on `git diff main...HEAD` with the spec and this plan; findings go to `$PM/review.md`, fixed inline, re-run Steps 1–3. Never skip this even if everything is green.

- [ ] **Step 10: Owner sign-off** — publish an artifact with the 12 × 320 `02-live`/`04-dock` images plus three 1280 pairs (base vs after), the control-set lists from Task 6 at 320 and 1280, and `$PM/verdicts.md`. Per-screen verdicts from the owner are the merge gate (spec ruling 0.5). Then open the PR (smoke runs on PRs; e2e runs only on push to `main` — say so in the PR body).

---

## Deviations from the spec (found while planning, by reading — record, do not re-derive)

1. **§3.7 Dock "full-width Cancel"** — there is no Cancel or Back; the dock's only dismiss is a 44×44 X icon. Chips become a 2-col grid; nothing else.
2. **§3.8 Recording chip `max-md:min-h-9`** — the chip already has `style={{ minHeight: 44 }}` inline; shrinking it would break the tap floor. It only moves.
3. **§3.9 Ledger footer** — the footer is an opaque `ReactNode` supplied by the console; it stays fully visible on phones. Only rows 2..N fold.
4. **§3.5 Context strip position** — moved below the dock on phones (`max-md:order-1`), because the cricket keypad otherwise lands below the 568px first screen. The striker/bowler facts remain on the scorebug rail above.
5. **§6.4 Byte-identical 768/1280 PNGs across two gallery runs** — impossible (random-tagged seeds per run). Replaced by the class audit (Task 8 Step 2) and the same-URL pixel re-check (Step 5).
6. **§5 e2e blast radius** — `mobile.spec.ts` never referenced hand-over; the `device-handover` hook is `data-role`, not `data-testid`, and is exercised only by `fixture-console-authority-band.test.tsx`. The 15 specs that click *Void* run in desktop-width projects and are unaffected.

## Self-review

- Spec coverage: §2 mechanism → Tasks 3/4 (+ audit in 8.2); §3.1 → 4; §3.2–3.4, 3.6–3.8 → 3; §3.5 → 3 (moved, deviation 4); §3.9 → 2; §3.10 → 5; §3.11 unchanged; §3.12 diff → 6 prints it; §4 → 1; §6.1 → 2/3/4/5; §6.2 → 6; §6.3 → 7; §6.4 → 8.2/8.5; §6.5 → 8.3 + Task 6 projects; §6.6 → 8.7/8.10; §6.7 → 8.1; §7 premises → re-pinned in each task's Files block; §8 out of scope respected (device-link page gets Tasks 2–3 only through the shared components; no Option 3).
- Names used across tasks: `collapsible`, `v3-activity-toggle`, `device-handover-phone`, `match-details-toggle`, `phone-disclosure-toggle`, `PhoneDisclosure`, `expectPhoneComposition`, `$PM/env.sh` — consistent.
