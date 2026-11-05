// The production-server boot finder the CI wiring tests share (relay-drivers-ci-wiring.test.ts, turnstile-ci-wiring.test.ts): every
// line of a workflow that boots a production server, and the env map of the step that OWNS it. One copy, so two tests cannot
// disagree about what a boot is. Moved verbatim out of relay-drivers-ci-wiring.test.ts.
import { expect } from "vitest";

// `start` as a whole script name: `npm run start:placement` is some other script, not the web server.
export const BOOT = /\bnode\b.*\bserver\.js\b|\bnext start\b|\b(?:npm|pnpm)\s+(?:run\s+)?start(?![\w:-])/;
/** A step's first line: a sequence item opening on one of a step's own keys. */
const STEP_START = /^(\s*)- (?:name|run|uses|id|if|env|with|shell|working-directory|timeout-minutes|continue-on-error):/;
const indentOf = (l: string): number => l.length - l.trimStart().length;
const skippable = (l: string): boolean => l.trim() === "" || /^\s*#/.test(l);

export type BootStep = { line: number; env: Record<string, string> };

/** For each production-server boot line: the env map of the step that owns it, read from THAT step's `env:` key. */
export function bootSteps(text: string): BootStep[] {
  const lines = text.split("\n");
  return lines.flatMap((l, i) => {
    if (!BOOT.test(l) || /^\s*#/.test(l)) return [];
    let start = i;
    while (start >= 0 && !STEP_START.test(lines[start]!)) start--;
    if (start < 0) return [{ line: i + 1, env: {} }];
    // The step's keys sit two columns right of its `- `; it ends at the first real line left of them.
    const keyIndent = indentOf(lines[start]!) + 2;
    const body = [lines[start]!.replace(/^(\s*)- /, (_, s: string) => `${s}  `)];
    for (let j = start + 1; j < lines.length && (skippable(lines[j]!) || indentOf(lines[j]!) >= keyIndent); j++) body.push(lines[j]!);
    // Guard: the boot line must lie inside the step found for it, or the attribution is someone else's.
    expect(start + body.length, `line ${i + 1} lies outside the step that starts at line ${start + 1}`).toBeGreaterThan(i);
    const env: Record<string, string> = {};
    const at = body.findIndex((b) => indentOf(b) === keyIndent && /^\s*env:\s*$/.test(b));
    if (at >= 0) {
      let childIndent: number | null = null;
      for (const b of body.slice(at + 1)) {
        if (skippable(b)) continue;
        if (indentOf(b) <= keyIndent) break;
        childIndent ??= indentOf(b);
        const m = indentOf(b) === childIndent ? /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*?)\s*$/.exec(b) : null;
        if (m) env[m[1]!] = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
      }
    }
    return [{ line: i + 1, env }];
  });
}

