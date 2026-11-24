---
name: docs-follow-product
description: Use when a change alters engine rules or an engine bump, scoring or pairing logic, UI copy, a label, route or testid, or a plan limit, before opening the PR. Brings the help and blog pages in line with the product in the same PR.
---

# Help and blog follow the product

Pages that disagree with the product are defects even under a green suite: the sweeps read the pages, not your change. Work the branches your change touches. Done means every touched branch met its criterion, and the PR body answers for the rest.

Run only the scoped commands below, from `apps/web`, never the full suite. Each writes its JSON report under `$TMPDIR` (export it as your scratch directory first; it falls back to `/tmp` when unset). Read results from the JSON file: `jq '{total: .numTotalTests, passed: .numPassedTests, failed: .numFailedTests, pending: .numPendingTests}' <file>`, and confirm `.testResults[].name` lists files under your worktree. Total 0 means the suites failed to collect.

## A. Engine or rules change (engine bump, scoring, pairing, standings, tie-breaks)

1. Run the blog example goldens:

```bash
cd apps/web && DATABASE_URL= npx vitest run --reporter=json --outputFile="${TMPDIR:-/tmp}/blog-goldens.json" src/blog/__tests__/blog-examples
```

2. A moved golden (a file in `apps/web/src/blog/examples/__golden__`) is a question, not a diff to accept. Read what moved and decide whether the product change intended it. Then list every post that renders it: `grep -a -rl -e "<example id>" apps/web/content/blog` (the id sits in the post's `examples:` frontmatter and in its `{{example:<id>}}` line).
3. Re-read each listed post against the new golden: every number, rank, name and sentence of explanation. Criterion: each listed post is read to the end and is either still true or edited.
4. Regenerate only after step 3, with `UPDATE_BLOG_EXAMPLES=1` in front of the command in step 1, and commit the golden diff on its own so a reviewer reads it. A plain `vitest -u` runs the whole suite and is not the tool.
5. Grep the help pages for the rule the change alters: `grep -a -rn -i -e "<rule word>" apps/web/content/help`. Fix every hit.
6. Run the blog sweeps. Two pending tests are expected without a server and a database: `blog-seo.live` (needs `BLOG_SEO_BASE`) and `blog-example-ladder.db`.

```bash
cd apps/web && DATABASE_URL= npx vitest run --reporter=json --outputFile="${TMPDIR:-/tmp}/blog-sweeps.json" src/blog/__tests__ src/server/__tests__/blog- src/app/blog/__tests__
```

## B. Copy, label, route or testid change

1. Grep both trees for the old label, route and testid: `grep -a -rn -F -e "<old text>" apps/web/content/help apps/web/content/blog`. Write each hit the way the English dictionary in `apps/web/src/dictionaries/en` spells the new label. Criterion: the grep for the old text prints nothing.
2. Check the page's pictures: help pages embed screenshots from `apps/web/public/help`. A changed screen leaves its picture stale, so recapture it or list it under Found, not fixed.
3. A renamed or moved help page updates the slug list in `apps/web/src/lib/help.ts`, every `related:` frontmatter line and every link to it. `HELP_REDIRECTS` stays empty (owner ruling: no redirects).
4. Run the help sweeps with a real database, so the matrix halves run (the `seazn-local-env` skill brings one up). A pending count above 0 means a database half did not run, and a skip is not a pass:

```bash
cd apps/web && npx vitest run --reporter=json --outputFile="${TMPDIR:-/tmp}/help-sweeps.json" src/lib/__tests__/help- src/server/__tests__/help- src/app/help/__tests__ src/server/__tests__/blog-help-links
```

## C. Plan limit change

1. Write every plan figure as a token, `{{plan:<feature_key>:<plan_key>}}`. Only integer cells render; a boolean or empty cell throws (`apps/web/src/server/help-tokens.ts`). `apps/web/src/lib/__tests__/help-no-typed-plan-figures.test.ts` rejects a typed figure.
2. Name a boolean gate by plan, and pin the sentence to `plan_entitlements` with a database test, as `apps/web/src/lib/__tests__/help-plan-scope-copy.test.ts` does for embeds and career stats.
3. Credits are "Seazn credits". Help and blog are English only; the four locale dictionaries do not apply.
4. Run the help sweeps from B.4 against a real database.

## D. A product defect met while writing

Describe the product as it behaves today, or leave the claim out. Add the defect to the PR body under **Found, not fixed**, with what the page would have said, what the product does, and `file:line`.

## PR body

- The template checkbox in `.github/pull_request_template.md`, ticked, or "not affected" with the reason.
- Pages touched, as paths.
- Goldens moved, with the posts re-read for each.
- Sweeps run, each with passed and total from the JSON file, and the pending count.
- **Found, not fixed**, when D applied.
