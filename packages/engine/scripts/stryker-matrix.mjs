// CLI: node packages/engine/scripts/stryker-matrix.mjs --event "$EVENT" --group "$GROUP" >> "$GITHUB_OUTPUT"
// W1d Task 15 (D14; rulings 66, 67): derives mutation.yml's job matrix. Prints ONE line,
//   matrix={"include":[{"group":"<key>","timeout":<minutes>}, ...]}
// and nothing else on stdout (the line is appended to $GITHUB_OUTPUT). Plain .mjs on purpose: the workflow's `plan` job runs
// it with `node` alone, before any install.
//   pull_request       -> the probe only (the PR self-proof, D3); a stray --group does not widen it
//   schedule           -> every STRYKER_GROUPS key except the probe
//   workflow_dispatch  -> --group all: every key except the probe; --group <key>: that key alone, the probe included
//   anything else      -> refused
// A group's timeout comes from stryker-timeouts.json (minutes; whole, at most 300): a selected group without one is refused,
// and so is an empty matrix. Each timeout is 1.5 times what the leg took on a hosted runner (a part cut after the run: 1.5 times its
// projected phase plus its dry run), from packages/engine/stryker-measured.json, the figures of GitHub run 37371368951 (sha
// 78c7ef3e6, ubuntu-latest, 4 vCPU), whole minutes, at least 10 and at most 300; the probe's is from its own sample, run 37330725739
// (T20 step 2; test/stryker-sizing.test.ts derives every one from the data). A different runner is a different wall: every
// timeout is re-derived whenever a hosted run disagrees with it, and whenever MATRIX_RUNNER changes.
// Exit codes, each with one meaning (the one convention, D8):
//   0  the matrix line was printed;
//   2  refused, nothing printed to stdout: usage, an unknown event or group, or a selected group without a valid timeout.
//   (3, a crash while loading, is not claimed: this runs under plain `node`, where a load crash exits 1.)
import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import { parseArgs } from "node:util";
import { STRYKER_GROUPS } from "../stryker.groups.mjs";

const MAX_MINUTES = 300; // ONE cap, everywhere (D14, Step 4, Task 20)
const USAGE = 'usage: stryker-matrix.mjs --event <pull_request|schedule|workflow_dispatch> [--group <all|group>]';

function refuse(message) {
  process.stderr.write(`stryker-matrix: ${message}\n`);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({ options: { event: { type: "string" }, group: { type: "string" } }, strict: true, allowPositionals: false }));
} catch (e) {
  refuse(`${e.message}\n${USAGE}`);
}

const all = Object.keys(STRYKER_GROUPS);
const nonProbe = all.filter((g) => g !== "probe");

function select(event, group) {
  switch (event) {
    case "pull_request":
      return ["probe"];
    case "schedule":
      return nonProbe;
    case "workflow_dispatch":
      if (group === undefined || group === "") return refuse(`a workflow_dispatch needs --group (all or one of ${all.join(", ")})\n${USAGE}`);
      if (group === "all") return nonProbe;
      if (!all.includes(group)) return refuse(`unknown group "${group}": expected all or one of ${all.join(", ")}`);
      return [group];
    default:
      return refuse(`unsupported event "${event ?? ""}": expected pull_request, schedule or workflow_dispatch\n${USAGE}`);
  }
}

const selected = select(values.event, values.group);

let timeouts;
try {
  timeouts = JSON.parse(readFileSync(new URL("../stryker-timeouts.json", import.meta.url), "utf8"));
} catch (e) {
  refuse(`stryker-timeouts.json is unreadable: ${e.message}`);
}
if (timeouts === null || typeof timeouts !== "object" || Array.isArray(timeouts)) refuse("stryker-timeouts.json must be an object of group -> minutes");

const include = selected.map((group) => {
  const timeout = timeouts[group];
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > MAX_MINUTES) {
    return refuse(`stryker-timeouts.json has no valid timeout for "${group}" (a whole number of minutes in 1..${MAX_MINUTES}; got ${JSON.stringify(timeout) ?? "nothing"})`);
  }
  return { group, timeout };
});
if (include.length === 0) refuse("the matrix is empty");

process.stdout.write(`matrix=${JSON.stringify({ include })}\n`);
