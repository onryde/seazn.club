// Capture record upload (spec 2026-10-12-capture-record-upload-design.md, approved by the owner 2026-10-12) — the pure
// rules: §5's line validation (the allow-list, then the secret-shaped values S1–S5), §0.1's token tag and §6's
// attribution (A1, A2). Pure: no I/O, no clock (domain-purity.test.ts). The use-case reads the body and the database.
//
// Nothing here ever returns, logs or quotes a VALUE from a line: a refusal names the line number, the key and the rule.
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

export type RecordValidation = { ok: true; lines: CaptureRecordLine[] } | { ok: false; message: string };
const REQUIRED = ["at", "kind"] as const;
const KNOWN_KEYS = new Set(Object.keys(CaptureRecordLine.shape));
/** A key is named in a refusal only when it looks like a key: an unknown key's NAME is still something the phone sent,
 *  and a 422 never echoes what it cannot vouch for. */
const NAMEABLE_KEY = /^[A-Za-z0-9_]{1,64}$/;
const nameOf = (key: string): string => (NAMEABLE_KEY.test(key) ? key : "a key");

/** The shape of ONE line (§5), or the refusal's text after `line N: `. */
function shapeOf(text: string): { ok: true; line: CaptureRecordLine } | { ok: false; why: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, why: "not JSON" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, why: "not a JSON object" };
  const keys = Object.keys(value);
  const unknown = keys.find((k) => !KNOWN_KEYS.has(k));
  if (unknown !== undefined) return { ok: false, why: `${nameOf(unknown)} is not on the allow-list` };
  const missing = REQUIRED.find((k) => !(k in value));
  if (missing !== undefined) return { ok: false, why: `${missing} is missing` };
  const parsed = CaptureRecordLine.safeParse(value);
  if (parsed.success) return { ok: true, line: parsed.data };
  const key = parsed.error.issues[0]?.path[0];
  // Every key is known and both required ones are present, so the issue sits under a key of the line.
  if (typeof key !== "string") throw new RangeError("shapeOf: a line refused with no key on its first issue");
  return { ok: false, why: `${key} is off its class` };
}

/**
 * §5: the whole body or nothing. `texts` are the record's NON-EMPTY lines in order, so "line N" is the Nth of the lines
 * that count toward the 1000. Shape and allow-list are judged on every line before any secret rule runs (§5's order);
 * the first refusal wins. Zero lines is a refusal (P10: 422).
 */
export function validateRecordLines(texts: readonly string[], bearer: string): RecordValidation {
  if (texts.length === 0) return { ok: false, message: "the record has no lines" };
  const lines: CaptureRecordLine[] = [];
  for (let i = 0; i < texts.length; i++) {
    const shaped = shapeOf(texts[i]!);
    if (!shaped.ok) return { ok: false, message: `line ${i + 1}: ${shaped.why}` };
    lines.push(shaped.line);
  }
  for (let i = 0; i < texts.length; i++) {
    // The RAW parsed values, not the twin's output: `at` is normalised by the twin, and the rule reads what was sent.
    const raw = JSON.parse(texts[i]!) as Record<string, unknown>;
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== "string") continue;
      const rules = secretRulesOf(value, bearer);
      if (rules.length > 0) return { ok: false, message: `line ${i + 1}: ${key} is secret-shaped (${rules[0]})` };
    }
  }
  return { ok: true, lines };
}

/** What attribution reads of a line: its kind, its sid and a pair line's tag. */
export type AttributableLine = { kind: string; sid?: string | null; tokenTag?: string };
/** The sending code, read at upload time: the sessions its pairings joined (A1, Q9) and T(code) (A2, §0.1). */
export type AttributionContext = { sessionsOfCode: ReadonlySet<string>; tagsOfCode: ReadonlySet<string> };
/** A window closes THROUGH these: the closing line belongs to the window it closes. */
const CLOSES = new Set(["unpaired", "ended"]);
const MASK = "***";

/**
 * §6: one verdict per line, in order — true = kept. A1: a uuid `sid` is kept iff its session is the sending code's,
 * wherever it falls. A masked sid is dropped. A2: a null or absent sid is kept iff it is inside a window of the
 * sending code — opened by a `pair` whose tokenTag is in T(code), closed through the next `unpaired`/`ended` or just
 * before the next `pair`. A line before the first `pair` is in no window (Q6: fails closed).
 */
export function attributeLines(lines: readonly AttributableLine[], ctx: AttributionContext): boolean[] {
  let inWindow = false;
  return lines.map((line) => {
    if (line.kind === "pair") inWindow = line.tokenTag !== undefined && ctx.tagsOfCode.has(line.tokenTag);
    const member = inWindow;
    if (CLOSES.has(line.kind)) inWindow = false;
    if (typeof line.sid === "string") return line.sid !== MASK && ctx.sessionsOfCode.has(line.sid.toLowerCase());
    return member;
  });
}
