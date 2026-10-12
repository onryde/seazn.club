// Capture record upload (spec 2026-10-12-capture-record-upload-design.md, approved by the owner 2026-10-12) — the pure
// rules: §5's line screen (the allow-list, then the secret-shaped values S1–S5), §0.1's token tag and §6's
// attribution (A1, A2). Pure: no I/O, no clock (domain-purity.test.ts). The use-case reads the body and the database.
//
// Owner ruling RL (2026-10-12): a bad line is DROPPED, never the body refused — `keptLines` is that policy, alone.
// Nothing here ever returns, logs or quotes a VALUE from a line, or the name of a key it refused.
import {
  CaptureRecordLine, CaptureRecordSecretS2, CaptureRecordSecretS3, CaptureRecordSecretS4, CaptureRecordSecretS5,
} from "@/server/api-v1/capture-schemas";

/**
 * §0.1 (Q8's default): the tag capture writes on a `pair` line — FNV-1a 32-bit over the token's UTF-16 code units,
 * eight lowercase hex digits. Capture's `wire/token-tag-vectors.json` is the rulebook (the test pins all nine).
 */
export function tokenTag(token: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Capture's `formsOf` (scrub.ts): raw, the form encoding (space as `+`, `! ' ( ) ~` escaped) and the component
 *  encoding. A lone surrogate has no encoded form, so the raw value is all there is. */
function formsOf(secret: string): string[] {
  let component: string;
  try {
    component = encodeURIComponent(secret);
  } catch {
    return [secret];
  }
  const form = component.replace(/%20/g, "+").replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return [secret, form, component];
}

export type SecretRule = "S1" | "S2" | "S3" | "S4" | "S5";
/** S2–S5 ARE the contract's `$defs.secretS2`–`secretS5` (their twins; the parity test pins the bytes). */
const SHAPED: readonly [SecretRule, { safeParse: (v: unknown) => { success: boolean } }][] = [
  ["S2", CaptureRecordSecretS2], ["S3", CaptureRecordSecretS3], ["S4", CaptureRecordSecretS4], ["S5", CaptureRecordSecretS5],
];

/** §5 P8: every rule a string value trips, in rule order. S1 is the SENDING Bearer in any of its three forms. */
export function secretRulesOf(value: string, bearer: string): SecretRule[] {
  // The route only ever passes a matched `Bearer <non-space>`: an empty one would make S1 match every string.
  if (bearer.length === 0) throw new RangeError("secretRulesOf: the sending Bearer is empty");
  const rules: SecretRule[] = [];
  if (formsOf(bearer).some((form) => value.includes(form))) rules.push("S1");
  for (const [rule, schema] of SHAPED) if (schema.safeParse(value).success) rules.push(rule);
  return rules;
}


/**
 * One line's verdict (§5, under the owner's ruling RL of 2026-10-12: a bad line is DROPPED, never the body refused).
 *  - `ok`: the line's shape is the contract's (the allow-list, each key in its class) and no string value is secret-shaped.
 *  - `secret`: the shape is good, so the line can still be READ for attribution (its kind, sid and tokenTag are
 *    validated values), but a string value trips a rule; the line is dropped.
 *  - `shape`: the line cannot be read — not UTF-8 (`null`, from record-body.ts), not JSON, not an object, a key off the
 *    allow-list or a value off its class. It is dropped, and attribution reads it as a boundary (`attributeLines`).
 * The verdict carries no value and no key name: a dropped line is counted and nothing more.
 */
export type ScreenedLine =
  /** `text` is what the server STORES: the very object it screened, re-serialised — never the bytes sent (review fix
   *  1, PR #943), so no spelling the screen did not see can reach storage. */
  | { ok: true; line: CaptureRecordLine; text: string }
  | { ok: false; why: "secret"; rule: SecretRule; line: CaptureRecordLine }
  | { ok: false; why: "shape" };

/**
 * Whether a JSON text names one key twice in any object (review fix 1, PR #943). JSON.parse keeps the LAST of two
 * same-named keys, so a first value — a credential, say — would pass a screen of the parsed object unseen. Keys
 * compare DECODED (`"a"` and `"a"` are one key). Only ever handed text JSON.parse accepted: an unterminated
 * string breaks that, and is a named refusal rather than a scan past the end.
 */
export function hasDuplicateKey(text: string): boolean {
  const objects: ({ keys: Set<string>; expectKey: boolean } | null)[] = [];   // null: an array
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') {
        if (j >= text.length) throw new RangeError("hasDuplicateKey: not JSON (an unterminated string)");
        j += text[j] === "\\" ? 2 : 1;
      }
      const top = objects.at(-1);
      if (top?.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (c === "{") objects.push({ keys: new Set(), expectKey: true });
    else if (c === "[") objects.push(null);
    else if (c === "}" || c === "]") objects.pop();
    else if (c === ",") {
      const top = objects.at(-1);
      if (top) top.expectKey = true;
    }
  }
  return false;
}

export function screenRecordLine(text: string | null, bearer: string): ScreenedLine {
  if (text === null) return { ok: false, why: "shape" };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, why: "shape" };
  }
  // Review fix 1: a key named twice hides its first value from everything below — the line cannot be read as sent.
  if (hasDuplicateKey(text)) return { ok: false, why: "shape" };
  // Review fix 2: the twin also refuses an own `__proto__` key, which zod's strict check would otherwise skip.
  const parsed = CaptureRecordLine.safeParse(raw);
  if (!parsed.success) return { ok: false, why: "shape" };
  // The RAW parsed values, not the twin's output: `at` is normalised by the twin, and the rule reads what was sent.
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const rules = secretRulesOf(value, bearer);
    if (rules.length > 0) return { ok: false, why: "secret", rule: rules[0]!, line: parsed.data };
  }
  return { ok: true, line: parsed.data, text: JSON.stringify(raw) };
}

/** What attribution reads of a line: its kind, its sid and a pair line's tag. */
export type AttributableLine = { kind: string; sid?: string | null; tokenTag?: string };
/** The sending code, read at upload time: the sessions its pairings joined (A1, Q9) and T(code) (A2, §0.1). */
export type AttributionContext = { sessionsOfCode: ReadonlySet<string>; tagsOfCode: ReadonlySet<string> };
/** A window closes THROUGH these: the closing line belongs to the window it closes. `unpaired` and `ended` from the
 *  allow-list's kinds; `pair-refused`, `engine-error` and `reset` added by capture's answer to Q7 (2026-10-12). */
export const WINDOW_CLOSING_KINDS: ReadonlySet<string> = new Set(["unpaired", "ended", "pair-refused", "engine-error", "reset"]);
const MASK = "***";

/**
 * §6: one verdict per line, in order — true = kept. A1: a uuid `sid` is kept iff its session is the sending code's,
 * wherever it falls. A masked sid is dropped. A2: a null or absent sid is kept iff it is inside a window of the
 * sending code — opened by a `pair` whose tokenTag is in T(code), closed through the next closing kind (Q7) or just
 * before the next `pair`. A line before the first `pair` is in no window (Q6: fails closed).
 *
 * `null` is a line the server could not read (a `shape` verdict). It is dropped, and it closes any open window just
 * before it, as a `pair` of no known code would: it may BE another code's `pair`, and a window run through it could
 * keep that code's lines (fails closed, like Q6).
 */
export function attributeLines(lines: readonly (AttributableLine | null)[], ctx: AttributionContext): boolean[] {
  let inWindow = false;
  return lines.map((line) => {
    if (line === null) {
      inWindow = false;
      return false;
    }
    if (line.kind === "pair") inWindow = line.tokenTag !== undefined && ctx.tagsOfCode.has(line.tokenTag);
    const member = inWindow;
    if (WINDOW_CLOSING_KINDS.has(line.kind)) inWindow = false;
    if (typeof line.sid === "string") return line.sid !== MASK && ctx.sessionsOfCode.has(line.sid.toLowerCase());
    return member;
  });
}

/**
 * THE bad-line policy, in one place (owner ruling RL, 2026-10-12): a line is kept iff attribution keeps it AND its
 * verdict is `ok`. A secret-shaped line is read like any other (it may open or close a window) and then dropped; an
 * unreadable line is a boundary (`attributeLines`). Nothing else in the record changes because of a bad line.
 */
export function keptLines(screened: readonly ScreenedLine[], ctx: AttributionContext): boolean[] {
  const readable = screened.map((s) => (s.ok || s.why === "secret" ? s.line : null));
  return attributeLines(readable, ctx).map((kept, i) => kept && screened[i]!.ok);
}
