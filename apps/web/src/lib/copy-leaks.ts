// Leak detector for user-facing copy. Pure: text in, findings out.
//
// Help (and, later, blog) copy is read by organisers and players. It must not
// carry the team's internal vocabulary — PR numbers, wave/task ids, spec marks,
// owner rulings, migration numbers, or developer words. findLeaks() finds them;
// LEAK_ALLOW lists the few exact phrases that look like a leak but are real copy.
//
// Callers normally pass helpPlainText(markdown), which turns "-" and "#" into
// spaces ("PROMPT-30" -> "PROMPT 30", "PR #12" -> "PR  12", "2026-10-27" ->
// "2026 10 27"). The patterns below therefore accept a space where the raw text
// has a hyphen or "#"; each is still anchored tightly enough that ordinary
// prose does not match.

export const LEAK_RULES = [
  "pr-number",
  "wave-id",
  "spec-mark",
  "internal-ruling",
  "migration-number",
  "developer-word",
] as const;
export type LeakRule = (typeof LEAK_RULES)[number];

export interface Leak {
  rule: LeakRule;
  match: string;
  index: number;
}

export interface LeakAllow {
  /** The exact phrase (case-sensitive). A hit lying inside an occurrence of it is not a leak. */
  match: string;
  reason: string;
}

export interface ScanOptions {
  /** A page written for developers (the API reference): webhook / endpoint are its subject, not a leak. */
  developerPage?: boolean;
}

// An ISO date, tolerant of the spaces helpPlainText leaves in place of hyphens.
const DATE = String.raw`\d{4}[-\s]\d{2}[-\s]\d{2}`;

const PATTERNS: Record<LeakRule, RegExp> = {
  // "PR #123", "PR 123" (after "#" is stripped), "pull request #123".
  "pr-number": /\b(?:PRs?|pull request)\s*#?\s*\d{2,}\b/gi,
  // R6, W2e, RS011, PROMPT-30, B07b, T10b — programme / wave / task ids.
  "wave-id": /\b(?:R\d{1,2}[a-z]?|W\d{1,2}[a-z]?|RS\d{3}|PROMPT[-\s]\d+|B\d{2}[a-z]?|T\d{1,2}[a-z]?)\b/g,
  // "§3.5", "spec 2026-10-27".
  "spec-mark": new RegExp(String.raw`§\s*\d|\bspec\s+${DATE}`, "gi"),
  // Rulings, not the role: "owner ruling", "owner-approved", "owner, 2026-…",
  // "decided 2026-…", "ruling … 2026-…". The word "owner" alone is real copy.
  "internal-ruling": new RegExp(
    String.raw`\bowner[\s-]+(?:ruling|rulings|approved|decision|ruled)\b` +
      String.raw`|\b(?:owner|ruling|rulings|decided)\b[^.\n]{0,20}?\b${DATE}\b` +
      String.raw`|\b${DATE}\b[^.\n]{0,20}?\b(?:owner|ruling|decided)\b`,
    "gi",
  ),
  // V519 — a database migration number.
  "migration-number": /\bV\d{3}\b/g,
  "developer-word":
    /\b(?:engine|reducer|payload|jsonb|webhooks?|cron|endpoints?|entitlements?)\b/gi,
};

/** developer-word matches that a developer page may use freely. */
const DEVELOPER_PAGE_OK = /^(?:webhooks?|endpoints?)$/i;

/**
 * A match code as the schedule, the scorer sheet and the format previews print
 * it: round, middle dot, match number ("Winner of R1·3"). Product vocabulary,
 * not a wave id. Ruling: round names are allowed ONLY as exact listed phrases,
 * never by loosening the wave-id pattern — so a code the engine's preview starts
 * to print that is not listed here fails the sweep and must be added on purpose.
 */
const MATCH_CODE_REASON =
  "Match code as the schedule, scorer sheet and format previews display it (round, middle dot, match number); product vocabulary, not a wave id.";
const MATCH_CODES = [
  "R1·1", "R1·2", "R1·3", "R1·4", "R2·1", "R2·2", "R3·1",
  "R7·1", "R7·2", "R8·1", "R8·2", "R9·1", "R10·1",
];

export const LEAK_ALLOW: LeakAllow[] = [
  {
    match: "T20",
    reason: "Twenty20 is the cricket format's real name, not a task id.",
  },
  ...MATCH_CODES.map((match) => ({ match, reason: MATCH_CODE_REASON })),
];

export interface ScanResult {
  leaks: Leak[];
  /** Hits that were suppressed by a LEAK_ALLOW phrase (so callers can prove each entry is live). */
  allowed: (Leak & { phrase: string })[];
}

/** Every [start, end) span in `text` occupied by an allow-listed phrase. */
function allowSpans(text: string): { start: number; end: number; phrase: string }[] {
  const spans: { start: number; end: number; phrase: string }[] = [];
  for (const { match } of LEAK_ALLOW) {
    for (let at = text.indexOf(match); at !== -1; at = text.indexOf(match, at + match.length)) {
      // An exact phrase, not a prefix of a longer token ("R1·1" must not excuse "R1·10").
      const before = text[at - 1] ?? "";
      const after = text[at + match.length] ?? "";
      if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;
      spans.push({ start: at, end: at + match.length, phrase: match });
    }
  }
  return spans;
}

export function scanCopy(text: string, opts: ScanOptions = {}): ScanResult {
  const leaks: Leak[] = [];
  const allowed: ScanResult["allowed"] = [];
  const spans = allowSpans(text);
  for (const rule of LEAK_RULES) {
    for (const m of text.matchAll(PATTERNS[rule])) {
      const hit: Leak = { rule, match: m[0], index: m.index! };
      if (rule === "developer-word" && opts.developerPage && DEVELOPER_PAGE_OK.test(hit.match)) continue;
      const covering = spans.find((s) => hit.index >= s.start && hit.index + hit.match.length <= s.end);
      if (covering) allowed.push({ ...hit, phrase: covering.phrase });
      else leaks.push(hit);
    }
  }
  leaks.sort((a, b) => a.index - b.index);
  return { leaks, allowed };
}

export function findLeaks(text: string, opts: ScanOptions = {}): Leak[] {
  return scanCopy(text, opts).leaks;
}
