// LIVE accuracy bench for the instruction parser (stage 1 of the AI schedule
// pipeline) — NOT a unit test. Makes real, billed calls.
//
//   PARSE_BENCH_LIVE=1 npx vitest run --root apps/web \
//     src/server/usecases/__tests__/schedule-ai-parse-bench.live.test.ts
//
// Optional: PARSE_BENCH_ONLY_ARM="<label>" to re-run one arm without re-billing
// the rest. PARSE_BENCH_CONCURRENCY (default 4).
//
// What is being measured, and why it is not cost. The parse round is capped at
// PARSE_TOKEN_CEILING = 2,000 output tokens and runs unpriced, outside
// spendCredit. At Haiku-direct list rates that is about ONE CENT per parse, so
// no model choice here moves the bill. What it moves is whether the organiser's
// brief is compiled correctly — and specifically whether a model INVENTS rules.
// schedule-ai-parse.ts's rule 2 exists because a rule presented as enforced
// while nothing enforces it is worse than no rule at all.
//
// The measurement trap this file is built around: parseInstruction NEVER
// throws. Transport failure, refusal, and a twice-missed schema all collapse
// into `{raw: null, failed: true}`. An OpenRouter endpoint that does not
// support `structured_outputs` therefore scores 0% while looking exactly like a
// model that is merely bad at the task. So every arm runs through an
// INSTRUMENTED provider that records the raw outcome of each call — HTTP status
// and body included — via parseInstruction's own `opts.provider` seam. No
// production code is changed to make the bench observable.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import corpus from "./fixtures/parse-corpus.json";
import { parseInstruction, type ParserContext } from "../schedule-ai-parse";
import { scoreCase, summarise, type BenchCase, type CaseScore } from "../parse-bench-score";
import { resolveProvider } from "../../ai/select-provider";
import type { AiChatRequest, AiChatResponse, AiProvider } from "../../ai/provider";

// vitest does not read .env.local. OPENROUTER_API_KEY lives only in the repo
// ROOT .env.local; ANTHROPIC_API_KEY is in both, so each key independently
// tries both paths rather than assuming one file holds both.
function loadEnvKeyIfAbsent(name: string): void {
  if (process.env[name]) return;
  for (const rel of ["../../../../.env.local", "../../../../../../.env.local"]) {
    const p = path.resolve(__dirname, rel);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(new RegExp(`^${name}=(.*)$`, "m"));
    if (!m) continue;
    const raw = m[1].trim();
    let value: string;
    if (raw[0] === '"' || raw[0] === "'") {
      const quote = raw[0];
      const end = raw.indexOf(quote, 1);
      value = end === -1 ? raw.slice(1) : raw.slice(1, end);
    } else {
      const hashIdx = raw.search(/\s#/);
      value = (hashIdx === -1 ? raw : raw.slice(0, hashIdx)).trim();
    }
    process.env[name] = value;
    break;
  }
}
loadEnvKeyIfAbsent("ANTHROPIC_API_KEY");
loadEnvKeyIfAbsent("OPENROUTER_API_KEY");

const LIVE = process.env.PARSE_BENCH_LIVE === "1";
const CONCURRENCY = Number(process.env.PARSE_BENCH_CONCURRENCY) || 4;

const CASES = corpus.cases as unknown as (BenchCase & { tier: number })[];
const CTX: ParserContext = corpus.context;

interface Arm {
  label: string;
  model: string;
  provider: "anthropic" | "openrouter";
  /** List rate, $/M output tokens, for the report only. Verified 2026-08-15. */
  usdPerMOut: number;
}

const ARMS: Arm[] = [
  { label: "haiku-4.5", model: "claude-haiku-4-5-20251001", provider: "anthropic", usdPerMOut: 5.0 },
  {
    label: "nemotron-3.5-lightning",
    model: "nvidia/nemotron-3.5-lightning",
    provider: "openrouter",
    usdPerMOut: 0.25,
  },
  { label: "glm-4.7-flash", model: "z-ai/glm-4.7-flash", provider: "openrouter", usdPerMOut: 0.4 },
  {
    label: "gemini-3.7-flash",
    model: "google/gemini-3.7-flash",
    provider: "openrouter",
    usdPerMOut: 1.875,
  },
  { label: "qwen3.8-27b", model: "qwen/qwen3.8-27b", provider: "openrouter", usdPerMOut: 3.2 },
];

/** Why a case produced no compiled rules. `parseInstruction` cannot tell these
 *  apart from the outside; the wrapper below can. */
type Diagnosis = "ok" | "schema-miss" | "refused" | "transport" | "unknown";

interface CallTrace {
  threw: string | null;
  parsedOk: boolean;
  refused: boolean;
  servedModel: string | null;
}

/** Delegating provider that records the raw outcome of every chat() call. */
function instrument(inner: AiProvider): { provider: AiProvider; trace: CallTrace[] } {
  const trace: CallTrace[] = [];
  return {
    trace,
    provider: {
      id: inner.id,
      isConfigured: () => inner.isConfigured(),
      async chat<T>(req: AiChatRequest<T>): Promise<AiChatResponse<T> | null> {
        try {
          const res = await inner.chat(req);
          trace.push({
            threw: null,
            parsedOk: res?.parsed != null,
            refused: res?.refused ?? false,
            servedModel: res?.servedModel ?? null,
          });
          return res;
        } catch (err) {
          trace.push({
            threw: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
            parsedOk: false,
            refused: false,
            servedModel: null,
          });
          throw err;
        }
      },
    },
  };
}

function diagnose(trace: CallTrace[], failed: boolean): Diagnosis {
  if (!failed) return "ok";
  if (trace.length === 0) return "unknown";
  if (trace.some((t) => t.threw)) return "transport";
  if (trace.some((t) => t.refused)) return "refused";
  if (trace.every((t) => !t.parsedOk)) return "schema-miss";
  return "unknown";
}

interface Row {
  arm: string;
  id: string;
  tier: number;
  score: CaseScore;
  diagnosis: Diagnosis;
  detail: string;
  tokens: number;
  secs: number;
  servedModel: string | null;
}

const ROWS: Row[] = [];

/** Bounded-concurrency map. The corpus is 34 cases; running them one at a time
 *  per arm would make a five-arm sweep needlessly long, and these are tiny
 *  independent calls. */
async function pooled<A, B>(items: A[], limit: number, fn: (item: A) => Promise<B>): Promise<B[]> {
  const out = new Array<B>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function runArm(arm: Arm): Promise<void> {
  const rows = await pooled(CASES, CONCURRENCY, async (benchCase) => {
    const { provider, trace } = instrument(resolveProvider(arm.provider));
    const t0 = Date.now();
    let outcome;
    try {
      outcome = await parseInstruction(benchCase.text, CTX, { provider, model: arm.model });
    } catch (err) {
      // parseInstruction is documented never to throw. If that ever changes,
      // the bench must say so rather than crash the sweep.
      outcome = { raw: null, failed: true, tokens: 0, servedModel: null };
      trace.push({
        threw: err instanceof Error ? err.message.slice(0, 300) : String(err),
        parsedOk: false,
        refused: false,
        servedModel: null,
      });
    }
    const secs = Math.round((Date.now() - t0) / 100) / 10;
    const diagnosis = diagnose(trace, outcome.failed);
    return {
      arm: arm.label,
      id: benchCase.id,
      tier: benchCase.tier,
      score: scoreCase(benchCase, outcome.raw),
      diagnosis,
      detail: trace.find((t) => t.threw)?.threw ?? "",
      tokens: outcome.tokens,
      secs,
      servedModel: outcome.servedModel,
    } satisfies Row;
  });
  ROWS.push(...rows);
}

describe.skipIf(!LIVE)("instruction parse bench (LIVE, billed)", () => {
  // Comma-separated, so a re-bench can target the arms that still matter
  // without re-billing the ones already settled.
  const only = new Set(
    (process.env.PARSE_BENCH_ONLY_ARM ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const selected = only.size > 0 ? ARMS.filter((a) => only.has(a.label)) : ARMS;

  it("has the keys its arms need", () => {
    expect(Boolean(process.env.ANTHROPIC_API_KEY)).toBe(true);
    if (selected.some((a) => a.provider === "openrouter")) {
      expect(Boolean(process.env.OPENROUTER_API_KEY)).toBe(true);
    }
  });

  for (const arm of selected) {
    it(`${arm.label} x${CASES.length} cases`, async () => {
      await runArm(arm);
      expect(ROWS.filter((r) => r.arm === arm.label).length).toBe(CASES.length);
    }, 900_000);
  }

  it("summary", () => {
    const write = (s: string) => process.stdout.write(s);
    write(`\n===== instruction parse bench — ${CASES.length} cases =====\n`);
    write(
      `${"arm".padEnd(24)}${"pass".padStart(8)}${"invent".padStart(8)}${"missing".padStart(9)}` +
        `${"failed".padStart(8)}${"tok".padStart(8)}${"s/case".padStart(8)}${"$/Mout".padStart(9)}\n`,
    );
    for (const arm of selected) {
      const armRows = ROWS.filter((r) => r.arm === arm.label);
      if (armRows.length === 0) continue;
      const s = summarise(armRows.map((r) => r.score));
      const tok = armRows.reduce((n, r) => n + r.tokens, 0);
      const secs = armRows.reduce((n, r) => n + r.secs, 0) / armRows.length;
      write(
        `${arm.label.padEnd(24)}${`${s.passed}/${s.total}`.padStart(8)}${String(s.invented).padStart(8)}` +
          `${String(s.missing).padStart(9)}${String(s.failed).padStart(8)}${String(tok).padStart(8)}` +
          `${secs.toFixed(1).padStart(8)}${arm.usdPerMOut.toFixed(2).padStart(9)}\n`,
      );
    }

    // Per-tier pass rate: a model can look fine overall while failing every
    // deferral row, which is the failure mode that actually reaches organisers.
    write(`\n--- pass rate by tier ---\n${"arm".padEnd(24)}`);
    const tiers = [...new Set(CASES.map((c) => c.tier))].sort();
    for (const t of tiers) write(`${`T${t}`.padStart(8)}`);
    write("\n");
    for (const arm of selected) {
      const armRows = ROWS.filter((r) => r.arm === arm.label);
      if (armRows.length === 0) continue;
      write(arm.label.padEnd(24));
      for (const t of tiers) {
        const tr = armRows.filter((r) => r.tier === t);
        write(`${`${tr.filter((r) => r.score.pass).length}/${tr.length}`.padStart(8)}`);
      }
      write("\n");
    }

    // Non-ok diagnoses, so an endpoint incapacity is never read as low accuracy.
    const bad = ROWS.filter((r) => r.diagnosis !== "ok");
    write(`\n--- non-answers (${bad.length}) ---\n`);
    for (const r of bad.slice(0, 40)) {
      write(`${r.arm.padEnd(24)}${r.id.padEnd(6)}${r.diagnosis.padEnd(14)}${r.detail.slice(0, 90)}\n`);
    }

    // Every invented rule, verbatim. This is the report's point.
    write(`\n--- invented rules ---\n`);
    for (const r of ROWS.filter((x) => x.score.invented.length > 0)) {
      for (const rule of r.score.invented) {
        write(`${r.arm.padEnd(24)}${r.id.padEnd(6)}${JSON.stringify(rule)}\n`);
      }
    }

    const out = path.resolve(__dirname, "../../../../parse-bench-results.json");
    fs.writeFileSync(out, JSON.stringify({ arms: selected, rows: ROWS }, null, 2));
    write(`\nartifact: ${out}\n`);
    expect(ROWS.length).toBeGreaterThan(0);
  });
});
