// W2c Task 15 (X-SR-7, owner P-1) — every client POST to /api/v1/fixtures/{id}/events is classified. A scoring pad
// sends the rules version it loaded; every other site must NOT (an absent version is never checked, so sending one
// would make a console action — start, void, settle, forfeit, abandon, finalize — refusable by a correction).
//
// Two pad shapes:
//  - `pad-literal`: the site writes its request body inline (the device chrome), so the version is in the site's own
//    body;
//  - `pad-built`: the site sends a body built elsewhere (the transport POSTs what `pipeline.ts`'s builder made), so the
//    site must pass that body through untouched, and the builder must carry the version. The builder's OUTPUT is pinned
//    by rules-version-transport.test.ts through the remote pad's real tap path.
//
// Run from `apps/web` (the vitest root): the scan's paths are relative to it.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";

type Kind = "pad-literal" | "pad-built" | "other";
const SITES: Readonly<Record<string, Kind>> = {
  "src/components/v2/scorepad/transport.ts": "pad-built",
  "src/components/v2/device-score-pad.tsx": "pad-literal",
  "src/components/v2/fixture-console.tsx": "other", // console chrome: start/void/settle/forfeit/abandon/finalize
  "src/components/v2/americano-panel.tsx": "other", // two sites
};
const PATTERN = "/api/v1/fixtures/\\$\\{[^}]+\\}/events`";
const WINDOW = 15;

function sites(): { file: string; line: number }[] {
  const out = execSync(
    `git grep -n -a -E '${PATTERN}' -- 'src/**/*.ts' 'src/**/*.tsx' ':!**/__tests__/**' ':!**/*.test.*'`,
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [file, line] = l.split(":");
      return { file: file!, line: Number(line) };
    });
}

const windowAt = (s: { file: string; line: number }) =>
  readFileSync(s.file, "utf8").split("\n").slice(s.line - 1, s.line - 1 + WINDOW).join("\n");

describe("P-1 events POST sites", () => {
  it("every site is classified, and the scan finds exactly the known five", () => {
    const found = sites();
    for (const s of found) expect(SITES[s.file], `${s.file}:${s.line} is not classified`).toBeDefined();
    expect(found).toHaveLength(5);
    expect(new Set(found.map((s) => s.file))).toEqual(new Set(Object.keys(SITES)));
  });

  it("a pad site sends rules_version within its request body; an other site does not", () => {
    let checked = 0;
    for (const s of sites()) {
      const body = windowAt(s);
      const kind = SITES[s.file];
      if (kind === "pad-built") {
        // The site sends the built body verbatim — never a re-spread that could drop or re-set a field.
        expect(body, `${s.file}:${s.line} passes the built body`).toMatch(/body:\s*JSON\.stringify\(body\)/);
        expect(/\brules_version\b/.test(body), `${s.file}:${s.line} must not set the version itself`).toBe(false);
      } else {
        expect(/\brules_version\b/.test(body), `${s.file}:${s.line}`).toBe(kind === "pad-literal");
      }
      checked++;
    }
    expect(checked).toBe(5);
  });

  it("the built body carries the version the queued event captured (pipeline.ts's builder)", () => {
    const src = readFileSync("src/components/v2/scorepad/pipeline.ts", "utf8");
    const builder = /function toRequestBody\([\s\S]*?\n\}/.exec(src)?.[0];
    expect(builder, "pipeline.ts declares the body builder").toBeDefined();
    expect(builder).toMatch(/rules_version: event\.rulesVersion/);
  });
});
