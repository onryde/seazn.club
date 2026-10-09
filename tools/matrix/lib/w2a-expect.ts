// The W2a "the 77 are green" judge (plan Task 16 Step 3), as code: the expectation Task 1 wrote
// (truth-runs/w2a-repro/expect-77.json, the 77 SC-O1/SC-O2 reds) read against the runs that followed it.
//
// Phase 3 review D-P2 (controller ruling, ledgered in progress.md): six boardgame L3 cells are not W2a's to turn green.
// They are RE-KEYED to the programme item that owns them (expect-77-rekeys.json: the gap they now belong to, its wave,
// and the reason the product must still give), and the judge passes for "71 works + 6 red with the pinned reason":
//   - a cell not re-keyed must be `works`;
//   - a re-keyed cell must be `red` AND say its pinned reason - red for any other reason fails, so a re-key can never
//     excuse a NEW defect on the same cell;
//   - a re-keyed cell that is `works` passes and is reported (`greened`): the pin is stale, drop it;
//   - an id no run holds is a refusal (ExpectedAbsent), never a pass over fewer cells; nothing read at all is NoCases.
// Pure: tools/matrix/w2a-expect.ts reads the files, this decides.
import { z } from "zod";
import type { CaseResult } from "./results.ts";

export const EXPECT_REFUSALS = ["ExpectUnreadable", "RekeysUnreadable", "RekeyNotExpected", "RekeyRepeated", "RunUnreadable", "NoCases", "CaseRepeated", "ExpectedAbsent"] as const;
export type ExpectRefusal = (typeof EXPECT_REFUSALS)[number];

export class ExpectRefused extends Error {
  constructor(name: ExpectRefusal, message: string) {
    super(message);
    this.name = name;
  }
}

const issuesOf = (e: z.ZodError): string => e.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");

/** One re-keyed cell: where it was (`was`), where it is owned now (`now`, in `wave`, by `rule` when one is named) and the
 *  reason it must still be red for. `ruling` names the ruling that moved it. */
const RekeySchema = z.strictObject({
  caseId: z.string().min(1),
  was: z.string().min(1),
  now: z.string().min(1),
  wave: z.string().min(1),
  rule: z.string().min(1).optional(),
  reason: z.string().trim().min(1),
  ruling: z.string().min(1),
});
export type Rekey = z.infer<typeof RekeySchema>;
const RekeysFileSchema = z.strictObject({ note: z.string().min(1), rekeys: z.array(RekeySchema) });

/** The expectation: a JSON list of distinct, non-empty case ids. */
export function parseExpect(json: unknown, label: string): string[] {
  const list = z.array(z.string().min(1)).safeParse(json);
  if (!list.success) throw new ExpectRefused("ExpectUnreadable", `${label}: not a JSON list of case ids - ${issuesOf(list.error)}`);
  if (new Set(list.data).size !== list.data.length) throw new ExpectRefused("ExpectUnreadable", `${label}: a case id is listed twice`);
  if (list.data.length === 0) throw new ExpectRefused("NoCases", `${label}: the expectation holds no case - nothing to judge (vacuous)`);
  return list.data;
}

/** The re-keys, held to the expectation they re-key: each names an id the expectation holds, once. */
export function parseRekeys(json: unknown, want: readonly string[], label: string): Rekey[] {
  const file = RekeysFileSchema.safeParse(json);
  if (!file.success) throw new ExpectRefused("RekeysUnreadable", `${label}: not a re-key file this judge reads - ${issuesOf(file.error)}`);
  const held = new Set(want);
  const seen = new Set<string>();
  for (const r of file.data.rekeys) {
    if (!held.has(r.caseId)) throw new ExpectRefused("RekeyNotExpected", `${label}: re-keys ${r.caseId}, which the expectation does not hold - a re-key moves a cell the expectation names`);
    if (seen.has(r.caseId)) throw new ExpectRefused("RekeyRepeated", `${label}: ${r.caseId} is re-keyed twice - which owner is it?`);
    seen.add(r.caseId);
  }
  return file.data.rekeys;
}

/** A pinned reason is compared with the double quotes dropped on both sides: the product writes `phase "pre"` and a ruling
 *  is quoted `phase pre`; nothing else is normalised. */
const bare = (s: string): string => s.replace(/["“”]/g, "");

/** Every place a case says why it is not green: its own reason line, then each failing check's reason and evidence. */
function sayings(c: Pick<CaseResult, "reason" | "checks">): string {
  return [c.reason, ...c.checks.filter((k) => k.verdict === "fail").flatMap((k) => [k.reason, ...k.evidence])].join("\n");
}

export interface ExpectVerdict {
  expected: number;
  /** Cases read across every source (zero is NoCases, never a pass). */
  read: number;
  found: number;
  /** Cells not re-keyed that are `works`. */
  works: number;
  /** Re-keyed cells that are red for their pinned reason. */
  pinnedRed: { caseId: string; now: string; wave: string }[];
  /** Re-keyed cells that are `works`: the pin is stale (reported, not a failure). */
  greened: string[];
  /** A cell not re-keyed that is not `works`. */
  unexpectedRed: { caseId: string; state: string; reason: string }[];
  /** A re-keyed cell that is not red for its pinned reason. */
  wrongReason: { caseId: string; wanted: string; got: string }[];
  exit: 0 | 1;
}

export interface Source { label: string; cases: readonly Pick<CaseResult, "caseId" | "state" | "reason" | "checks">[] }

/** The first source that holds a case decides it (CI before local); a case twice in ONE source is refused. */
export function judgeExpectation(a: { want: readonly string[]; rekeys: readonly Rekey[]; sources: readonly Source[] }): ExpectVerdict {
  const rekeyOf = new Map(a.rekeys.map((r) => [r.caseId, r]));
  const decided = new Map<string, Source["cases"][number]>();
  let read = 0;
  for (const s of a.sources) {
    const mine = new Set<string>();
    for (const c of s.cases) {
      read++;
      if (mine.has(c.caseId)) throw new ExpectRefused("CaseRepeated", `${s.label} holds ${c.caseId} twice - which row is the case?`);
      mine.add(c.caseId);
      if (!decided.has(c.caseId)) decided.set(c.caseId, c);
    }
  }
  if (a.want.length === 0 || read === 0) throw new ExpectRefused("NoCases", `nothing to judge: ${a.want.length} expected id(s), ${read} case(s) read (vacuous)`);
  const absent = a.want.filter((id) => !decided.has(id));
  if (absent.length > 0) throw new ExpectRefused("ExpectedAbsent", `${absent.length} expected case(s) are in no run given: ${absent.slice(0, 5).join(", ")}${absent.length > 5 ? ", ..." : ""}`);
  const v: ExpectVerdict = { expected: a.want.length, read, found: 0, works: 0, pinnedRed: [], greened: [], unexpectedRed: [], wrongReason: [], exit: 0 };
  for (const id of a.want) {
    const c = decided.get(id)!;
    v.found++;
    const rk = rekeyOf.get(id);
    if (rk === undefined) {
      if (c.state === "works") v.works++;
      else v.unexpectedRed.push({ caseId: id, state: c.state, reason: c.reason });
    } else if (c.state === "works") {
      v.greened.push(id);
    } else if (c.state === "red" && bare(sayings(c)).includes(bare(rk.reason))) {
      v.pinnedRed.push({ caseId: id, now: rk.now, wave: rk.wave });
    } else {
      v.wrongReason.push({ caseId: id, wanted: rk.reason, got: c.state === "red" ? c.reason : `${c.state}: ${c.reason}` });
    }
  }
  v.exit = v.unexpectedRed.length > 0 || v.wrongReason.length > 0 ? 1 : 0;
  return v;
}
