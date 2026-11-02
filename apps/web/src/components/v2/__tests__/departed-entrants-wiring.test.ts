// Two seams this workspace cannot drive, guarded at the source.
//
// `apps/web` vitest is `environment: "node"`: there is no jsdom, no
// @testing-library, and `renderToStaticMarkup` runs no handlers — so the
// ladder panel's catch block and an RSC page's own derivation are both
// unreachable from a unit test. Both were found UNTESTED by the re-review's
// mutation campaign (N21, N22), and both have real behaviour tests in
// Playwright (`e2e/ladder-withdrawn-challenge.spec.ts`,
// `e2e/withdrawn-entrant-seeding.spec.ts`) — but e2e triggers on push to
// `main` only, so on a pull request these scans are the only thing standing
// between a deleted seam and a green gate.
//
// What a scan can and cannot do: it kills "the call was removed" and "the
// argument was hardcoded". It cannot tell you the result reaches a screen.
// Neither claim is made beyond that; the e2e specs named above are what prove
// the behaviour, and if one of these ever disagrees with the other, the
// browser wins.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/**
 * The source text of every JSX mount of `names` in `source`, from `<Name` to its OWN closing `/>`, found by brace depth and not by
 * the first `/>` (a prop's value may hold one, and an `entrantStatuses=` hiding after it must still be inside the span). A mount
 * that never closes, or one that swallows the next mount, is a scanner defect and fails loudly rather than shrinking the span.
 */
function mounts(source: string, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(new RegExp(`<(?:${names.join("|")})\\s`, "g"))) {
    let depth = 0;
    let end = -1;
    for (let i = m.index; i < source.length; i += 1) {
      const c = source[i];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === "/" && source[i + 1] === ">" && depth === 0) {
        end = i + 2;
        break;
      }
    }
    expect(end, `scanner: the <${m[0].slice(1).trim()}> mount at offset ${m.index} never closes`).toBeGreaterThan(-1);
    const span = source.slice(m.index, end);
    expect(
      countMounts(span, names),
      `scanner: the mount at offset ${m.index} swallowed another mount`,
    ).toBe(1);
    out.push(span);
  }
  return out;
}
const countMounts = (span: string, names: readonly string[]): number =>
  [...span.matchAll(new RegExp(`<(?:${names.join("|")})\\s`, "g"))].length;

/**
 * What is wrong with how ONE mount receives the entrants' statuses (W3 T15 ruling 2); [] = nothing. Three kinds of mount:
 *  - "sheet": the StagesPanel's `<RunSheet>`. The statuses reach it ONLY through the shared `{...runSheetProps}` spread, so it
 *    names the prop nowhere. An `entrantStatuses=` after the spread overrides it (`={{}}`, `={undefined}`), one before is dead
 *    weight that reads as a second source: both are refused (review m1).
 *  - "row": a direct `<RunSheetRow>` / `<RowWithNow>` in run-sheet.tsx. It names the prop EXACTLY once, as `{entrantStatuses}`.
 *    Zero occurrences is the dropped hand-over; two is an override; one with another value is a literal.
 *  - "wrapper": `RowWithNow`'s own `<RunSheetRow … {...rest} />`. The prop rides `...rest`, so it names it nowhere.
 */
function statusProblems(mount: string, kind: "sheet" | "row" | "wrapper"): string[] {
  const named = (mount.match(/\bentrantStatuses=/g) ?? []).length;
  const problems: string[] = [];
  if (kind === "sheet") {
    if (!mount.includes("{...runSheetProps}")) problems.push("does not spread {...runSheetProps}");
    if (named > 0) problems.push(`names entrantStatuses= ${named}x beside the spread (an override or a second source)`);
  } else if (kind === "wrapper") {
    if (!mount.includes("{...rest}")) problems.push("does not spread {...rest}");
    if (named > 0) problems.push(`names entrantStatuses= ${named}x beside the spread (an override or a second source)`);
  } else {
    if (named !== 1) problems.push(`names entrantStatuses= ${named}x, expected exactly once`);
    if (!mount.includes("entrantStatuses={entrantStatuses}")) problems.push("does not hand over {entrantStatuses} (a literal or another value)");
  }
  return problems;
}

describe("the ladder panel localises a challenge refusal (N21)", () => {
  const source = read("components/v2/ladder-panel.tsx");

  it("routes an ApiV1Error through ladderErrorMessage rather than err.message", () => {
    expect(source).toContain('import { ladderErrorMessage } from "@/lib/ladder-error"');
    // The call, with the component's `locale` prop as the locale — not a
    // literal. A hardcoded "en" renders English copy to a French organiser
    // and passes every English assertion there is.
    expect(source).toMatch(/setError\(\s*ladderErrorMessage\(\s*locale\s*,/);
    // The negative pair: no branch sets the raw server prose as the error for
    // an ApiV1Error. `err.message` survives only as the FALLBACK argument to
    // the resolver above, and in the non-ApiV1Error branch.
    expect(source).not.toMatch(/setError\(\s*err\.message\s*\)/);
  });

  it("takes its locale as a prop, because it renders outside a DictProvider", () => {
    expect(source).toMatch(/locale:\s*Locale;/);
  });
});

describe("the division page treats a disqualification as a departure (N22)", () => {
  const source = read("app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx");

  it("derives departedEntrantIds from the shared vocabulary, not a status literal", () => {
    const match = source.match(/const departedEntrantIds = [\s\S]{0,300}?\.map\(/);
    expect(match, "departedEntrantIds is no longer derived on this page").not.toBeNull();
    const derivation = match![0];
    // This assertion USED to be `toContain('"withdrawn"')` plus the same for
    // `"disqualified"`, which was right about the intent and wrong about where
    // to look: `standings-withdrawn-wiring.test.ts` forbids this page spelling
    // the vocabulary at all, because a page that names one status will miss
    // the next one added — and the two guards then contradicted each other.
    //
    // The intent it was protecting (a DISQUALIFICATION narrows the pickers
    // exactly as a withdrawal does — the half a mutation dropped with nothing
    // going red) has not been weakened, it has MOVED to where it can no longer
    // be satisfied by a page-local literal: `DEPARTED_STATUSES` is pinned to
    // the schema's own status list in
    // `public-site/__tests__/departed-vocabulary-is-single-sourced.test.ts`.
    // Narrowing that set to `withdrawn` alone reds there.
    expect(derivation).toContain("DEPARTED_STATUSES.has");
    expect(
      derivation,
      "the page restates the departed vocabulary — read it from DEPARTED_STATUSES instead",
    ).not.toMatch(/"(withdrawn|disqualified)"/);
    // And it is imported from the one place that owns it, not redeclared here.
    expect(source).toMatch(/import\s*\{[^}]*DEPARTED_STATUSES[^}]*\}\s*from\s*"@\/server\/usecases\/entrants"/);
  });

  it("hands that list to every panel whose pickers must not offer her", () => {
    // LadderPanel and ProgressionPanel both receive it; a new panel that
    // renders an entrant picker and does not is the next instance of this
    // defect.
    const passes = [...source.matchAll(/departedEntrantIds=\{departedEntrantIds\}/g)];
    expect(passes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("the fixture page treats a disqualification as a departure in the settle dialog (loop-F tidy)", () => {
  // The server refuses a settle naming a departed winner over DEPARTED_STATUSES (append-event.ts C17; driven in
  // settle-seating.test.ts "C17 over the ONE departed vocabulary"). The page's `withdrawn` flag is what keeps the
  // SettleDialog from offering that refused choice (needs-decision.test.tsx drives the dialog off the flag), so it must
  // read the same set — a page-local "withdrawn" literal offered a disqualified entrant.
  const source = read("app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx");

  it("derives the settle flag from DEPARTED_STATUSES, never a status literal", () => {
    const match = source.match(/withdrawn: [^,\n]+,/);
    expect(match, "the side's settle flag is no longer derived on this page").not.toBeNull();
    expect(match![0]).toBe("withdrawn: DEPARTED_STATUSES.has(entrant.status),");
    expect(source).toMatch(/import\s*\{[^}]*DEPARTED_STATUSES[^}]*\}\s*from\s*"@\/server\/usecases\/entrants"/);
  });
});

describe("the fixture console hands the held block the line's next-match read (loop-F tidy 2)", () => {
  // The dialog's no-choice sentence branches on it (needs-decision.test.tsx "tidy-2"); the page passes the read
  // (stream-mount.test.tsx "hands the console whether the line feeds a next match"). This is the link between them —
  // the console renders the dialog only once opened, so a static render of the console cannot see the prop.
  const source = read("components/v2/fixture-console.tsx");
  it("passes fixture.feeds_next_match to NeedsDecisionBlock", () => {
    const block = source.match(/<NeedsDecisionBlock[\s\S]*?\/>/);
    expect(block, "the console mounts the held block").not.toBeNull();
    expect(block![0]).toContain("feedsNextMatch={fixture.feeds_next_match}");
  });
});

// W3 T15 ruling 2 (controller, 2026-11-02): the organiser's run sheet and fixture console word a DISQUALIFIED entrant's
// cascade walkover as a disqualification, never a withdrawal — from her status, which only the pages read. The rows'
// and the console's own behaviour is driven by render (run-sheet-row.test.tsx, fixture-console-decided-line.test.tsx);
// this is the link from each page to them, which no static render of a client component can see.
describe("the organiser pages hand the entrants' statuses to the readers that word a disqualification (W3 T15 ruling 2)", () => {
  it("division page → StagesPanel → RunSheet → every RunSheetRow", () => {
    const page = read("app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx");
    const mount = page.match(/<StagesPanel\s[\s\S]*?\/>/);
    expect(mount, "the division page mounts the StagesPanel").not.toBeNull();
    expect(mount![0]).toContain("entrantStatuses={entrantStatuses}");
    // The statuses are the raw roster read, one per entrant (the same map the qualification view reads).
    expect(page).toMatch(/const entrantStatuses = Object\.fromEntries\(entrants\.map\(\(e\) => \[e\.id, e\.status\]\)\)/);

    const panel = read("components/v2/stages-panel.tsx");
    // Match Day #1103 (E1/C3) retired the division-wide `<RunSheet>` that carried the prop by name: each stage card mounts its own
    // sheet from ONE shared object, `runSheetProps`. So the link is now two halves, both pinned: every RunSheet mount spreads that
    // object and names the prop nowhere else (so nothing overrides it), and the object carries the statuses.
    const sheets = mounts(panel, ["RunSheet"]); // the opening tag is `<RunSheet` + whitespace: comments mention "`<RunSheet>`"
    expect(sheets.length, "the StagesPanel mounts the RunSheet").toBeGreaterThan(0);
    for (const sheet of sheets) {
      expect(statusProblems(sheet, "sheet"), `a RunSheet mount in stages-panel.tsx:\n${sheet}`).toEqual([]);
    }
    const shared = panel.match(/const runSheetProps = \{[\s\S]*?\n  \};\n/);
    expect(shared, "the StagesPanel builds the shared run-sheet props").not.toBeNull();
    // Shorthand (`entrantStatuses,`): the destructured prop itself, never a literal map (`entrantStatuses: {}` type-checks and
    // renders every DQ walkover as a withdrawal).
    expect(shared![0]).toMatch(/\n\s+entrantStatuses,\n/);
    expect(shared![0], "the shared props never restate the statuses as a key: value").not.toMatch(/\bentrantStatuses\s*:/);

    // Every site that hands a row its names hands it the statuses too, MOUNT BY MOUNT (a count of `entrantStatuses={entrantStatuses}`
    // could not see a second, overriding `entrantStatuses=` on a mount that also carries the right one - review m1): the direct
    // mounts (Match Day added the round-bar `RowWithNow`), each naming the prop once as the destructured value, and the day
    // wrapper (whose `...rest` reaches the row), which must neither pull the prop out of `rest` nor restate it.
    const runSheet = read("components/v2/desk/run-sheet.tsx");
    const rowMounts = mounts(runSheet, ["RowWithNow", "RunSheetRow"]);
    const wrappers = rowMounts.filter((m) => m.includes("{...rest}"));
    const direct = rowMounts.filter((m) => !m.includes("{...rest}"));
    expect(direct.length, "premise: the sheet mounts a row five ways").toBeGreaterThanOrEqual(5);
    expect(wrappers.length, "premise: RowWithNow forwards its props to the row through ...rest").toBeGreaterThanOrEqual(1);
    for (const row of direct) {
      expect(row, "premise: this mount is one that hands the row its names").toContain("entrantNames={entrantNames}");
      expect(statusProblems(row, "row"), `a row mount in run-sheet.tsx:\n${row}`).toEqual([]);
    }
    for (const wrapper of wrappers) {
      expect(statusProblems(wrapper, "wrapper"), `a wrapper mount in run-sheet.tsx:\n${wrapper}`).toEqual([]);
    }
    const fn = runSheet.match(/function RowWithNow\(\{([\s\S]*?)\}: \{([\s\S]*?)\n\}\) \{/);
    expect(fn, "RowWithNow keeps its destructure-and-type shape").not.toBeNull();
    expect(fn![1], "RowWithNow must not pull the statuses out of ...rest").not.toContain("entrantStatuses");
    expect(fn![2], "RowWithNow's props declare the statuses so they survive into ...rest").toContain("entrantStatuses?: ForfeitEntrantStatuses");
  });

  it("the scan sees the overrides it exists for: an override after the spread, one hiding past a `/>`, a literal, a dropped hand-over (review m1)", () => {
    // The scanner's own mutants, each against a clean control: a scan nothing kills is decoration.
    const cleanSheet = '<RunSheet {...runSheetProps} embedded stageId={stage.id} />';
    const cleanRow = '<RunSheetRow key={f.id} entrantNames={entrantNames} entrantStatuses={entrantStatuses} courtNames={courtNames} />';
    const cleanWrapper = '<RunSheetRow fixture={fixture} href={hrefFor(fixture)} {...rest} />';
    expect(statusProblems(cleanSheet, "sheet"), "control: a clean sheet mount").toEqual([]);
    expect(statusProblems(cleanRow, "row"), "control: a clean row mount").toEqual([]);
    expect(statusProblems(cleanWrapper, "wrapper"), "control: a clean wrapper mount").toEqual([]);

    const killed: Array<[string, string, "sheet" | "row" | "wrapper"]> = [
      ["override after the spread", '<RunSheet {...runSheetProps} entrantStatuses={{}} embedded />', "sheet"],
      ["undefined after the spread", '<RunSheet {...runSheetProps} entrantStatuses={undefined} />', "sheet"],
      ["spread dropped", '<RunSheet embedded stageId={stage.id} />', "sheet"],
      ["second source before the spread", '<RunSheet entrantStatuses={entrantStatuses} {...runSheetProps} />', "sheet"],
      ["row: override after the right value", cleanRow.replace(" courtNames", " entrantStatuses={{}} courtNames"), "row"],
      ["row: literal in place of the value", cleanRow.replace("entrantStatuses={entrantStatuses}", "entrantStatuses={{}}"), "row"],
      ["row: hand-over dropped", cleanRow.replace(" entrantStatuses={entrantStatuses}", ""), "row"],
      ["wrapper: restated beside ...rest", '<RunSheetRow fixture={fixture} {...rest} entrantStatuses={{}} />', "wrapper"],
    ];
    for (const [name, mount, kind] of killed) {
      expect(statusProblems(mount, kind), name).not.toEqual([]);
    }

    // The span finder follows braces, not the first `/>`: an override AFTER a prop value that holds a `/>` is still inside it.
    const hidden = '<RunSheetRow a={<i />} entrantNames={entrantNames} entrantStatuses={entrantStatuses} entrantStatuses={{}} />\n<RunSheetRow b={1} />';
    const spans = mounts(hidden, ["RunSheetRow"]);
    expect(spans.length, "anti-vacuity: both mounts found").toBe(2);
    expect(statusProblems(spans[0]!, "row"), "the override past the inner `/>` is seen").not.toEqual([]);
  });

  it("the fixture page hands each side its status", () => {
    const page = read("app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]/page.tsx");
    const side = page.match(/async function side\([\s\S]*?\n  \}\n/);
    expect(side, "the fixture page builds its sides").not.toBeNull();
    expect(side![0]).toContain("status: entrant.status,");
  });
});

// W3 T17 (RB3-19, X-SW-25): the cut-drift warning is computed on the division page and rendered by StagesPanel. The only
// behaviour witness is the e2e describe "X-SW-25 the desk warns after a cut-changing correction"; this scan exists so a
// rebase that drops the prop (the StagesPanel mount moved under Match Day #1103) reds on a pull request, not after merge.
//
// Match Day PB1 (#1105) folds a COMPLETED stage's card to one line, its body `hidden`, and the warning lives on a completed Swiss:
// the page must ALSO list the stages that carry it as `attentionStageIds`, from the same predicate the card draws the notice from
// (`swissCutDriftOf`). Two props that must travel together are the wiring a scan can pin: a mount with one and not the other is the
// inert seam (a warning inside a body nobody opens). The card half is driven by render (swiss-cut-drift-warning.test.tsx).
describe("the division page feeds the Swiss cut-drift warning to the stages panel (W3 T17)", () => {
  const page = read("app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx");
  const panel = read("components/v2/stages-panel.tsx");

  it("derives the drift from getSwissCutDrift for every completed Swiss and passes it to StagesPanel", () => {
    const derivation = page.match(/const swissCutDrift = [\s\S]{0,600}?getSwissCutDrift\(auth, s\.id\)/);
    expect(derivation, "swissCutDrift is no longer derived from getSwissCutDrift on this page").not.toBeNull();
    expect(derivation![0]).toMatch(/s\.kind === "swiss" && s\.status === "complete"/);
    expect(page).toMatch(/swissCutDrift=\{swissCutDrift\}/);
    // The negative pair: never a literal map, which would type-check and render nothing.
    expect(page).not.toMatch(/swissCutDrift=\{\{/);
  });

  it("renders the warning from the shared predicate (swissCutDriftOf), not a condition of its own", () => {
    expect(panel).toMatch(/const cutDrift = swissCutDriftOf\(\s*stage,\s*canEdit,\s*swissCutDrift\s*\)/);
    expect(panel).toContain('data-testid="swiss-cut-drift-warning"');
    expect(panel).toMatch(/swissCutDriftText\(\s*cutDrift,/);
    // The negative pair: no inline restatement of the condition beside it (a second copy is how the two drift apart).
    expect(panel).not.toMatch(/swissCutDrift\?\.\[stage\.id\]/);
    expect(panel).not.toMatch(/swissCutDrift\[stage\.id\]/);
  });

  /** Every non-test source file under `src/app` and `src/components` that mounts the StagesPanel, with its mounts. */
  function stagesPanelMounts(): { file: string; mount: string }[] {
    const found: { file: string; mount: string }[] = [];
    for (const root of ["app", "components"]) {
      for (const entry of readdirSync(join(SRC, root), { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.tsx$/.test(entry.name)) continue;
        const dir = (entry as unknown as { parentPath?: string; path?: string }).parentPath ?? (entry as unknown as { path: string }).path;
        if (/__tests__/.test(dir)) continue;
        const source = readFileSync(join(dir, entry.name), "utf8");
        for (const mount of source.includes("<StagesPanel") ? mounts(source, ["StagesPanel"]) : []) {
          found.push({ file: join(dir, entry.name).slice(SRC.length + 1), mount });
        }
      }
    }
    return found;
  }

  /** What is wrong with ONE StagesPanel mount's cut-drift hand-over; [] = nothing. */
  function cutDriftProblems(mount: string): string[] {
    const named = (prop: string) => (mount.match(new RegExp(`\\b${prop}=`, "g")) ?? []).length;
    const problems: string[] = [];
    const drift = named("swissCutDrift");
    const attention = named("attentionStageIds");
    if (drift !== 1) problems.push(`names swissCutDrift= ${drift}x, expected exactly once`);
    if (attention !== 1) problems.push(`names attentionStageIds= ${attention}x, expected exactly once (a mount with the drift and not the attention list hides the warning in a folded card)`);
    // The list is built from the SAME three values the mount hands the panel for stages / canEdit / swissCutDrift - read off the
    // mount itself, never typed here - through the one helper, so a literal, a stale copy or another list cannot pass.
    const value = (prop: string) => new RegExp(`\\b${prop}=\\{([^{}]*)\\}`).exec(mount)?.[1]?.trim();
    const stages = value("stages");
    const canEdit = value("canEdit");
    const driftValue = value("swissCutDrift");
    if (stages === undefined || canEdit === undefined || driftValue === undefined) {
      problems.push("does not hand stages= / canEdit= / swissCutDrift= as plain {values}");
    } else if (!mount.includes(`attentionStageIds={swissCutDriftStageIds(${stages}, ${canEdit}, ${driftValue})}`)) {
      problems.push(`attentionStageIds is not {swissCutDriftStageIds(${stages}, ${canEdit}, ${driftValue})}`);
    }
    return problems;
  }

  it("every StagesPanel mount that receives the drift also receives the attention list, built from the same predicate", () => {
    const all = stagesPanelMounts();
    expect(all.length, "anti-vacuity: the scan found StagesPanel mounts").toBeGreaterThan(0);
    const withDrift = all.filter((m) => /\bswissCutDrift=/.test(m.mount));
    expect(withDrift.map((m) => m.file), "premise: the division page is the mount that receives the drift").toEqual(["app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx"]);
    for (const { file, mount } of withDrift) {
      expect(cutDriftProblems(mount), `the StagesPanel mount in ${file}:\n${mount}`).toEqual([]);
    }
    // The converse: nobody lists attention stages without the drift that explains them (a literal list would sit here).
    for (const { file, mount } of all) {
      if (/\battentionStageIds=/.test(mount)) expect(/\bswissCutDrift=/.test(mount), `${file} names attentionStageIds= without swissCutDrift=`).toBe(true);
    }
    expect(page).toMatch(/import \{ swissCutDriftStageIds \} from "@\/lib\/swiss-cut-drift"/);
  });

  it("the scan sees what it exists for: the attention list dropped, a literal, a wrong editability, another map, a duplicate (mutants against a clean control)", () => {
    const clean = '<StagesPanel stages={stages} canEdit={editable} swissCutDrift={swissCutDrift} attentionStageIds={swissCutDriftStageIds(stages, editable, swissCutDrift)} />';
    expect(cutDriftProblems(clean), "control: a clean mount").toEqual([]);
    const killed: Array<[string, string]> = [
      ["attention list dropped", clean.replace(" attentionStageIds={swissCutDriftStageIds(stages, editable, swissCutDrift)}", "")],
      ["empty literal", clean.replace("swissCutDriftStageIds(stages, editable, swissCutDrift)", "[]")],
      ["editability hardcoded", clean.replace("(stages, editable, swissCutDrift)", "(stages, true, swissCutDrift)")],
      ["another map", clean.replace("(stages, editable, swissCutDrift)", "(stages, editable, {})")],
      ["a second, overriding list", clean.replace(" />", " attentionStageIds={[]} />")],
      ["drift dropped, list kept", clean.replace(" swissCutDrift={swissCutDrift}", "")],
    ];
    let checked = 0;
    for (const [name, mount] of killed) {
      expect(cutDriftProblems(mount), name).not.toEqual([]);
      checked++;
    }
    expect(checked, "anti-vacuity: every mutant run").toBe(killed.length);
  });
});
