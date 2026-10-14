// Parses the rules reference out of the INSTALLED tarball with the testkit's own parser (engine-split Tasks 1b-3 and 1d-5, R12).
//
// `@seazn/engine/testkit` resolves to the packed `dist/testkit/index.js`; its rules parser reads `rules/*.md` from the package root,
// which ships in the tarball (package.json "files"). The one URL that finds them, `../../rules` from the module, is right from
// `src/testkit/` in the workspace and from `dist/testkit/` here, and this is the run that proves the second half. Prints the rows
// parsed per rules file and their total; run.mjs holds both against the workspace's own parse (and a total of zero is a failure there).
import { allRows, ruleFiles } from "@seazn/engine/testkit";

const files = ruleFiles();
const rows = allRows();
const perFile = Object.fromEntries(files.map((f) => [f, rows.filter((r) => r.file === f).length]));
console.log(`RULES_BY_FILE ${JSON.stringify(perFile)}`);
console.log(`rules: ${rows.length}`);
