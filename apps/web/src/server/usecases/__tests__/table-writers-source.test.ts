// W2d Task 10 (spec §5.5 "Write paths": "A source-scan test enumerates every SQL write to `divisions.tiebreakers` and
// `stages.config` with `grep -a` and fails on any writer that does not call the validator").
//
// What counts as a write of a tie-break order: an INSERT of a division or a stage row (each carries its order or its whole
// config), an UPDATE of `divisions` that names `tiebreakers` or sets columns from a dynamic list, and an UPDATE of
// `stages.config` that writes a `tiebreakers` / `crossGroupTiebreakers` key or a config that is not a literal-key merge.
// Each must sit in a top-level function that calls `validateCascade` itself or a guard of `table-rule-guards.ts` that does.
// The other `stages.config` writers (a literal-key merge of `rules`, `rank_overrides`, `ladder_order`, …, or a key
// removal) cannot write an order: they are counted as exempt, so a scan that stopped seeing writers would red.
// Non-test files under apps/web/src/server, found with `git grep -a` (files here read as binary to a bare grep).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = resolve(__dirname, "../../../..");
const SERVER = "src/server";
const GUARDS = resolve(WEB, SERVER, "usecases/table-rule-guards.ts");

/** Top-level function declarations of a file, each with its body (to the next top-level declaration). */
function topLevelFunctions(text: string): { name: string; start: number; end: number; body: string }[] {
  const lines = text.split("\n");
  const decl = /^(?:export )?(?:async )?function\*? (\w+)/;
  const top = /^(?:export )?(?:async )?function|^(?:export )?(?:const|let|class|interface|type) /;
  const out: { name: string; start: number; end: number; body: string }[] = [];
  lines.forEach((line, i) => {
    const m = decl.exec(line);
    if (m === null) return;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) if (top.test(lines[j]!)) { end = j; break; }
    out.push({ name: m[1]!, start: i + 1, end, body: lines.slice(i, end).join("\n") });
  });
  return out;
}

/** The guards that validate an order: those of table-rule-guards.ts whose own body calls `validateCascade`, and those that
 *  call one of them (closed over the file). */
function cascadeGuards(): Set<string> {
  const fns = topLevelFunctions(readFileSync(GUARDS, "utf8"));
  const guards = new Set(fns.filter((f) => /\bvalidateCascade\(/.test(f.body)).map((f) => f.name));
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of fns) {
      if (guards.has(f.name)) continue;
      if ([...guards].some((g) => new RegExp(`\\b${g}\\(`).test(f.body))) {
        guards.add(f.name);
        grew = true;
      }
    }
  }
  return guards;
}

/** Every SQL write a statement grep finds, with its file, line and the statement's text (to its closing backtick). */
function sqlWrites(): { file: string; line: number; text: string }[] {
  const out = execFileSync(
    "git",
    ["grep", "-n", "-a", "-E", "insert into (stages|divisions)|update (stages|divisions) set", "--", SERVER, ":!**/__tests__/**"],
    { cwd: WEB, encoding: "utf8" },
  );
  const hits: { file: string; line: number; text: string }[] = [];
  for (const row of out.split("\n").filter(Boolean)) {
    const [file, line] = row.split(":") as [string, string];
    const lines = readFileSync(resolve(WEB, file), "utf8").split("\n");
    const from = Number(line) - 1;
    let text = "";
    for (let j = from; j < Math.min(lines.length, from + 12); j++) {
      text += lines[j]! + "\n";
      if (j > from && lines[j]!.includes("`")) break;
      if (j === from && (lines[j]!.match(/`/g) ?? []).length >= 2) break;
    }
    hits.push({ file, line: Number(line), text });
  }
  return hits;
}

const LITERAL_MERGE = /config = config \|\| \$\{\w+\.json\(\{([^}]*)\}/;
const KEY_REMOVAL = /config = config - '(\w+)'/;
const ORDER_KEY = /\b(tiebreakers|crossGroupTiebreakers)\b/;

/** Does this write carry a tie-break order? Exempt writes return the reason. */
function classify(text: string): "order" | "exempt" | "other" {
  if (/insert into (stages|divisions)/.test(text)) return "order";
  if (/update divisions set/.test(text)) return ORDER_KEY.test(text) || /\$\{q\(values/.test(text) ? "order" : "other";
  if (/update stages set[\s\S]*config/.test(text)) {
    const merge = LITERAL_MERGE.exec(text);
    if (merge !== null) return ORDER_KEY.test(merge[1]!) ? "order" : "exempt";
    const removal = KEY_REMOVAL.exec(text);
    if (removal !== null) return ORDER_KEY.test(removal[1]!) ? "order" : "exempt";
    return ORDER_KEY.test(text) ? "order" : "exempt";
  }
  return "other";
}

describe("W2d T10 every writer of a tie-break order validates it (source scan)", () => {
  it("every SQL write to divisions.tiebreakers and stages.config under W/server is in a function that calls validateCascade (counted; 0 fails)", () => {
    const guards = cascadeGuards();
    expect(guards.size, "anti-vacuity: the guards module has a guard that calls validateCascade").toBeGreaterThan(0);
    const writes = sqlWrites();
    let checked = 0;
    let exempt = 0;
    const fails: string[] = [];
    for (const w of writes) {
      const kind = classify(w.text);
      if (kind === "exempt") exempt++;
      if (kind !== "order") continue;
      checked++;
      const fns = topLevelFunctions(readFileSync(resolve(WEB, w.file), "utf8"));
      const owner = fns.find((f) => f.start <= w.line && w.line < f.end);
      const validates =
        owner !== undefined && (/\bvalidateCascade\(/.test(owner.body) || [...guards].some((g) => new RegExp(`\\b${g}\\(`).test(owner.body)));
      if (!validates) fails.push(`${w.file}:${w.line} (${owner?.name ?? "top level"})`);
    }
    console.info(`[table-writers-source] ${checked} order writers, ${exempt} exempt config writers, guards: ${[...guards].join(", ")}`);
    expect(checked, "anti-vacuity: order writers found").toBeGreaterThanOrEqual(6);
    expect(exempt, "anti-vacuity: the scan sees the other config writers too").toBeGreaterThan(0);
    expect(fails, "writers that never validate the order").toEqual([]);
  });
});
