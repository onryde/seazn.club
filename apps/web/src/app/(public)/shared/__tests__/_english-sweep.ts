// The zero-English sweep's machinery: what a visitor can read on a rendered
// page, and whether each piece of it is explained by the page locale's own
// dictionary. `english-sweep.test.tsx` drives it over every /shared page.
//
// WHY NOT A LIST OF OLD ENGLISH STRINGS. A list checked for absence only ever
// finds the strings someone already knew about, and it false-positives on
// words that are the same in two languages (Dutch "Live", "Sponsors",
// "Partners"; French "Infos" contains English "Info"). This works the other
// way round: every string on the page must be ACCOUNTED FOR, so a literal
// nobody has heard of yet is found the first time it renders.
//
// A segment (a text node, or a visible attribute) is accounted for when, in
// the page's locale:
//   1. it is DATA — seeded names (every scene seeds its free text with the
//      marker `zq`, which no dictionary contains), numbers, and dates/times/
//      zones as `Intl` writes them in that locale (derived below, never typed);
//   2. or it equals one of that locale's dictionary VALUES (any namespace);
//   3. or it matches a value that has `{placeholders}`, and every placeholder's
//      text is itself accounted for — so "Siguiente: sáb 5 sept 14:00" is
//      explained by "Siguiente: {when}" plus a date, but "Siguiente: Copy link"
//      is not. A text node is often a FRAGMENT of such a value (a template
//      split around an element: "Powered by <span>{brand}</span>"), so any run
//      of a value's literal pieces between placeholders counts too. A literal
//      piece is matched as WHOLE words: es "{a} y {b}" explains "Ana y Luis",
//      never the "y" inside English "by";
//   4. or it is accounted-for pieces a component joined with its own
//      separator (" · ", " — ") or punctuation ("83/6 (8.0 ov, RR 10.38)").
//
// What is left is classified:
//   - `english`: equal to an en dictionary value whose value in this locale
//     DIFFERS (or is missing) — a surviving English literal, with its key;
//   - `foreign`: equal to another locale's value — the wrong dictionary;
//   - `hardcoded`: in no dictionary at all.
// An allowlist (`_english-sweep-allowlist.ts`) names the genuine exceptions,
// each with its reason, as whole words, optionally scoped to one page; and the
// real leaks owed outside this lane, marked as such.
import { readdirSync, readFileSync } from "node:fs";
import { LOCALES, type Locale } from "@/lib/i18n-constants";
import { intlLocaleFor } from "@/lib/public-date-locale";

const DICT_ROOT = new URL("../../../../dictionaries/", import.meta.url);

/** Every seeded free-text string in a scene carries this, and nothing else may. */
export const DATA_MARKER = "zq";

// ------------------------------------------------------------------ segments

export interface Segment {
  text: string;
  /** "text", "@aria-label", "meta:title", … — where a finding was read. */
  where: string;
}

/** The attributes a person perceives: read aloud, shown on hover, shown in
 *  place of an image or an empty field. */
const VISIBLE_ATTRS = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "aria-placeholder",
  "title",
  "alt",
  "placeholder",
  "label",
]);

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITY[body.toLowerCase()] ?? whole;
  });
}

/** Whitespace as a reader sees it: every space-like character is one space. */
export const norm = (s: string) => s.replace(/[\s\u00a0\u202f\u2009\u200b]+/g, " ").trim();

/**
 * Text nodes and visible attribute values of a `renderToStaticMarkup` string.
 * `<!-- -->` (React's separator between adjacent text children) splits a
 * node, as it does in the DOM. `<script>`/`<style>` bodies are not read: the
 * only script a public page ships inline is JSON-LD, which is for crawlers.
 */
export function extractSegments(html: string): Segment[] {
  const out: Segment[] = [];
  const body = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  for (const token of body.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? []) {
    if (token.startsWith("<!--")) continue;
    if (token.startsWith("<")) {
      const isInputButton = /^<input\b/i.test(token) && /\btype="(button|submit|reset)"/i.test(token);
      for (const m of token.matchAll(/([a-zA-Z][\w:-]*)="([^"]*)"/g)) {
        const name = m[1]!.toLowerCase();
        if (VISIBLE_ATTRS.has(name) || (isInputButton && name === "value")) {
          const text = norm(decodeEntities(m[2]!));
          if (text) out.push({ text, where: `@${name}` });
        }
      }
      continue;
    }
    const text = norm(decodeEntities(token));
    if (text) out.push({ text, where: "text" });
  }
  return out;
}

type MetadataLike = Record<string, unknown>;

/**
 * The metadata Next SERVES for a page: every layout above it, then the page,
 * merged SHALLOWLY in that order (`next/dist/docs/01-app/03-api-reference/
 * 04-functions/generate-metadata.md`, "Merging"). A field the page sets
 * replaces the layout's whole; a field it leaves out is INHERITED — which is
 * how a page that sets only `robots` serves the root layout's English
 * description, and why reading a page's own object alone could never see it.
 *
 * The title is resolved the way Next writes `<title>`: a page's string title
 * goes through the nearest `title.template` above it, `{ absolute }` skips the
 * template, and a page with no title serves the layout's `title.default`.
 * `layouts` is root first.
 */
export function servedMetadata(layouts: readonly (MetadataLike | null | undefined)[], page: MetadataLike | null | undefined): MetadataLike {
  let merged: MetadataLike = {};
  let template: string | undefined;
  let title: unknown;
  for (const segment of [...layouts, page]) {
    if (!segment) continue;
    const own = segment.title;
    if (own !== undefined) title = resolveTitle(own, template);
    if (own && typeof own === "object" && typeof (own as MetadataLike).template === "string") {
      template = (own as MetadataLike).template as string;
    }
    merged = { ...merged, ...segment };
  }
  return { ...merged, title };
}

function resolveTitle(own: unknown, template: string | undefined): unknown {
  const apply = (s: string) => (template ? template.replace("%s", s) : s);
  if (typeof own === "string") return apply(own);
  if (own && typeof own === "object") {
    const o = own as MetadataLike;
    if (typeof o.absolute === "string") return o.absolute;
    if (typeof o.default === "string") return apply(o.default);
  }
  return own;
}

/** The strings a page's `generateMetadata` hands the document head. */
export function metadataSegments(meta: unknown, path = "meta"): Segment[] {
  const out: Segment[] = [];
  if (meta === null || meta === undefined) return out;
  if (typeof meta === "string") {
    const text = norm(meta);
    if (text) out.push({ text, where: path });
    return out;
  }
  if (Array.isArray(meta)) {
    meta.forEach((m, i) => out.push(...metadataSegments(m, `${path}[${i}]`)));
    return out;
  }
  if (typeof meta === "object") {
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
      // Words a person reads: titles, descriptions, image alt text, site name.
      if (["title", "description", "alt", "siteName", "default", "absolute", "template"].includes(k)) {
        out.push(...metadataSegments(v, `${path}.${k}`));
      } else if (["openGraph", "twitter", "images"].includes(k)) {
        out.push(...metadataSegments(v, `${path}.${k}`));
      } else if (/^\d+$/.test(k)) {
        out.push(...metadataSegments(v, `${path}.${k}`));
      }
    }
  }
  return out;
}

// -------------------------------------------------------------- dictionaries

interface Template {
  key: string;
  re: RegExp;
  /** The run's longest literal piece, lower-cased: a cheap substring test that
   *  skips the regex for nearly every segment. */
  anchor: string;
}

interface LocaleIndex {
  /** lower-cased normalised value → its keys ("public:landing.tab.info") */
  exact: Map<string, string[]>;
  /** key → lower-cased normalised value */
  byKey: Map<string, string>;
  templates: Template[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PLACEHOLDER = /\{[^{}]+\}/;
const hasLetters = (s: string) => /\p{L}/u.test(s);

/** Every run of a value's literal pieces, placeholder text as captures — the
 *  whole value, and each fragment an element could split it into. */
function templatesOf(key: string, value: string): Template[] {
  const pieces = value.split(PLACEHOLDER).map((p) => norm(p).toLowerCase());
  const n = pieces.length - 1;
  const out: Template[] = [];
  for (let i = 0; i <= n; i++) {
    for (let j = i; j <= n; j++) {
      const run = pieces.slice(i, j + 1);
      if (!run.some(hasLetters)) continue;
      let src = "^";
      if (i > 0) src += "(.*?)\\s*";
      run.forEach((piece, k) => {
        // A piece that starts or ends with a letter is a WORD: es "{a} y {b}"
        // must not find its "y" inside "by", nor fr "à" inside "déjà".
        if (/^\p{L}/u.test(piece)) src += "(?<!\\p{L})";
        src += escapeRe(piece).replace(/ /g, "\\s*");
        if (/\p{L}$/u.test(piece)) src += "(?!\\p{L})";
        if (k < run.length - 1) src += "\\s*(.*?)\\s*";
      });
      if (j < n) src += "\\s*(.*?)";
      src += "$";
      // Longest piece WITH letters: a bare " · " or ":" would let nearly
      // every segment through to the regex.
      const anchor = run.filter(hasLetters).sort((a, b) => b.length - a.length)[0]!;
      out.push({ key, re: new RegExp(src, "isu"), anchor });
    }
  }
  return out;
}

const indexes = new Map<string, LocaleIndex>();

export function dictionaryIndex(locale: Locale): LocaleIndex {
  const hit = indexes.get(locale);
  if (hit) return hit;
  const index: LocaleIndex = { exact: new Map(), byKey: new Map(), templates: [] };
  const dir = new URL(`${locale}/`, DICT_ROOT);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const ns = file.replace(/\.json$/, "");
    const dict = JSON.parse(readFileSync(new URL(file, dir), "utf8")) as Record<string, string>;
    for (const [k, raw] of Object.entries(dict)) {
      if (typeof raw !== "string") continue;
      const key = `${ns}:${k}`;
      const value = norm(raw).toLowerCase();
      index.byKey.set(key, value);
      if (PLACEHOLDER.test(raw)) index.templates.push(...templatesOf(key, raw));
      else if (hasLetters(value)) index.exact.set(value, [...(index.exact.get(value) ?? []), key]);
    }
  }
  indexes.set(locale, index);
  return index;
}

// --------------------------------------------------------------------- data

/** The words `Intl` writes dates, times, zones and relative times with in a
 *  locale: months, weekdays, day periods, zone names, and the literal words
 *  between fields ("de", "à", "om"). Derived per locale, never typed. */
const dateWordCache = new Map<string, RegExp>();

function dateWordsRe(locale: Locale): RegExp {
  const hit = dateWordCache.get(locale);
  if (hit) return hit;
  const tag = intlLocaleFor(locale);
  const words = new Set<string>();
  const take = (parts: Intl.DateTimeFormatPart[] | Intl.RelativeTimeFormatPart[]) => {
    for (const p of parts) if (p.type !== "integer" && hasLetters(p.value)) words.add(norm(p.value).toLowerCase());
  };
  const zones = ["UTC", "Europe/London", "Europe/Madrid", "Europe/Paris", "Europe/Amsterdam", "America/Los_Angeles", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"];
  const shapes: Intl.DateTimeFormatOptions[] = [
    { month: "long" },
    { month: "short" },
    { day: "numeric", month: "long" },
    { day: "numeric", month: "short" },
    { weekday: "long" },
    { weekday: "short" },
    { weekday: "long", day: "numeric", month: "long" },
    { weekday: "short", day: "numeric", month: "short" },
    { day: "numeric", month: "long", year: "numeric" },
    { day: "numeric", month: "short", year: "numeric" },
    { hour: "numeric", minute: "2-digit", hour12: true },
    { dateStyle: "full", timeStyle: "short" },
    { dateStyle: "long", timeStyle: "short" },
    { dateStyle: "medium", timeStyle: "short" },
    { dateStyle: "short", timeStyle: "short" },
  ];
  // Every month (the 15th), and every weekday (5–11 January 2026, Monday to
  // Sunday) — each instant through every shape, so each name meets each form.
  const instants = [
    ...Array.from({ length: 12 }, (_, month) => new Date(Date.UTC(2026, month, 15, 12))),
    ...Array.from({ length: 7 }, (_, day) => new Date(Date.UTC(2026, 0, 5 + day, 12))),
  ];
  for (const at of instants) {
    for (const shape of shapes) take(new Intl.DateTimeFormat(tag, { ...shape, timeZone: "UTC" }).formatToParts(at));
    for (const timeZone of zones) {
      for (const timeZoneName of ["short", "long", "shortOffset"] as const) {
        take(new Intl.DateTimeFormat(tag, { hour: "2-digit", timeZone, timeZoneName }).formatToParts(at));
      }
    }
  }
  for (const numeric of ["always", "auto"] as const) {
    const rtf = new Intl.RelativeTimeFormat(tag, { numeric });
    for (const unit of ["second", "minute", "hour", "day", "week", "month", "year"] as const) {
      for (const v of [-2, -1, 0, 1, 2, 5]) take(rtf.formatToParts(v, unit));
    }
  }
  const alternation = [...words].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
  const re = new RegExp(`(?<![\\p{L}])(?:${alternation})(?![\\p{L}])`, "giu");
  dateWordCache.set(locale, re);
  return re;
}

const DATA_RE = new RegExp(`[\\p{L}\\p{N}_-]*${DATA_MARKER}[\\p{L}\\p{N}_-]*`, "giu");
const dataCache = new Map<string, string>();

/** Allowlisted phrases out, as whole words only: "GA" is accounted for as
 *  a column header, never as the middle of some other word that contains it. */
const allowRes = new Map<string, RegExp>();
function stripAllowed(text: string, allow: readonly string[]): string {
  if (allow.length === 0) return text;
  const key = allow.join("\u0001");
  let re = allowRes.get(key);
  if (!re) {
    const alternation = [...allow].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
    re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternation})(?![\\p{L}\\p{N}])`, "gu");
    allowRes.set(key, re);
  }
  return text.replace(re, " ");
}

/** Names, numbers and URLs out; every word kept, `Intl`'s included. */
function withoutNames(text: string, allow: readonly string[]): string {
  return stripAllowed(text, allow).replace(/\bhttps?:\/\/\S+/giu, " ").replace(DATA_RE, " ").replace(/\p{N}+/gu, " ");
}

/** The segment with its data removed: seeded names, numbers, `Intl` date
 *  words, allowlisted phrases. Letters left over mean words someone wrote. */
export function withoutData(text: string, locale: Locale, allow: readonly string[]): string {
  const cacheKey = `${locale}\u0000${allow.join("\u0001")}\u0000${text}`;
  const hit = dataCache.get(cacheKey);
  if (hit !== undefined) return hit;
  let s = stripAllowed(text, allow);
  // A URL is an address, not words — the poster prints its own link.
  s = s.replace(/\bhttps?:\/\/\S+/giu, " ");
  s = s.replace(DATA_RE, " ");
  s = s.replace(dateWordsRe(locale), " ");
  s = s.replace(/\p{N}+/gu, " ");
  dataCache.set(cacheKey, s);
  return s;
}

// ------------------------------------------------------------ classification

const MAX_DEPTH = 4;

/** The segment, and the segment without the glyphs a page decorates copy
 *  with at its edges ("🖨 Imprimir", "Presentar ▸", "← 9zqorg"): an icon
 *  beside a word does not make the word someone else's. */
function forms(text: string, locale: Locale, allow: readonly string[]): string[] {
  const edges = (x: string) => norm(x).replace(/^[\p{S}\p{P}\s]+|[\p{S}\p{P}\s]+$/gu, "");
  const s = norm(text);
  // And without its data: a label beside its count ("En vivo 1") is the label.
  // Twice — once without names, numbers and URLs only, because the full strip
  // also takes `Intl`'s date words, and those are real words too: fr "à" is a
  // date connective, so "À venir 7" stripped fully is "venir", in no dictionary.
  return [
    ...new Set([s, edges(s), edges(withoutNames(s, allow)), edges(withoutData(s, locale, allow))]),
  ].filter(Boolean);
}

/** Pieces a page joins with a separator of its own ("Noticias · 9zqorg"),
 *  captured so a run of pieces can be put back together exactly. */
const SEPARATOR = /(\s+[·•|—–]\s+)/u;
/** Punctuation a component writes around values it composes itself. */
const PUNCTUATION = /\s*[(),;:/]\s*/u;

const explainedCache = new Map<string, boolean>();

/** Accounted for by `locale`'s dictionary, as data, or by the allowlist. */
export function explained(text: string, locale: Locale, allow: readonly string[], depth = 0): boolean {
  const cacheKey = `${locale}\u0000${depth}\u0000${allow.join("\u0001")}\u0000${text}`;
  const hit = explainedCache.get(cacheKey);
  if (hit !== undefined) return hit;
  const answer = explainedUncached(text, locale, allow, depth);
  explainedCache.set(cacheKey, answer);
  return answer;
}

function explainedUncached(text: string, locale: Locale, allow: readonly string[], depth: number): boolean {
  const s = norm(text);
  if (!hasLetters(withoutData(s, locale, allow))) return true;
  if (depth >= MAX_DEPTH) return false;
  const index = dictionaryIndex(locale);
  for (const form of forms(s, locale, allow)) {
    const lower = form.toLowerCase();
    if (index.exact.has(lower)) return true;
    for (const tpl of index.templates) {
      if (!lower.includes(tpl.anchor)) continue;
      const m = tpl.re.exec(form);
      if (m && m.slice(1).every((cap) => explained(cap ?? "", locale, allow, depth + 1))) return true;
    }
  }
  // Cut at the separators into RUNS, every run accounted for on its own — not
  // only into single pieces, because a value can carry the separator itself:
  // the served title "9zqcup — cartel QR — Seazn Club" is es
  // `qrPoster.metaTitle` ("{competition} — cartel QR") with the root layout's
  // title template (" — Seazn Club") after it. Any cut will do; the whole
  // segment is not a cut (it was tried above).
  const pieces = s.split(SEPARATOR);
  const count = (pieces.length + 1) / 2;
  const run = (from: number, to: number) => pieces.slice(2 * from, 2 * to - 1).join("");
  const cuts = (from: number): boolean => {
    for (let to = from + 1; to <= count; to++) {
      if (from === 0 && to === count) continue;
      if (explained(run(from, to), locale, allow, depth + 1) && (to === count || cuts(to))) return true;
    }
    return false;
  };
  if (count > 1 && cuts(0)) return true;
  // Values a component glues with its own punctuation in ONE text node: the
  // scorecard's "83/6 (8.0 ov, RR 10.38)" is `oversShort` and `runRateShort`
  // inside brackets it writes itself. Every piece must be THIS locale's.
  const bits = s.split(PUNCTUATION).filter((bit) => bit.trim() !== "");
  return bits.length > 1 && bits.every((bit) => explained(bit, locale, allow, depth + 1));
}

export interface Finding {
  kind: "english" | "foreign" | "hardcoded";
  text: string;
  where: string;
  /** For `english`/`foreign`: the dictionary keys whose value it is. */
  keys: string[];
}

function valueKeys(text: string, locale: Locale, allow: readonly string[]): string[] {
  const index = dictionaryIndex(locale);
  const keys: string[] = [];
  for (const form of forms(text, locale, allow)) {
    const lower = form.toLowerCase();
    keys.push(...(index.exact.get(lower) ?? []));
    for (const tpl of index.templates) {
      if (!lower.includes(tpl.anchor)) continue;
      const m = tpl.re.exec(form);
      if (m && m.slice(1).every((cap) => explained(cap ?? "", locale, allow, 1))) keys.push(tpl.key);
    }
  }
  return [...new Set(keys)];
}

/** Null when the segment is accounted for in `locale`; otherwise what it is. */
export function classify(seg: Segment, locale: Locale, allow: readonly string[]): Finding | null {
  if (explained(seg.text, locale, allow)) return null;
  const target = dictionaryIndex(locale);
  const english = valueKeys(seg.text, "en", allow).filter((key) => {
    const mine = target.byKey.get(key);
    return mine === undefined || mine !== dictionaryIndex("en").byKey.get(key);
  });
  if (english.length > 0) return { kind: "english", text: seg.text, where: seg.where, keys: english };
  for (const other of LOCALES) {
    if (other === locale || other === "en") continue;
    const keys = valueKeys(seg.text, other, allow);
    if (keys.length > 0) return { kind: "foreign", text: seg.text, where: seg.where, keys: keys.map((k) => `${other}:${k}`) };
  }
  return { kind: "hardcoded", text: seg.text, where: seg.where, keys: [] };
}

/** Segments that ARE a dictionary value of `locale` (not data, not a bare
 *  placeholder fill) — the positive half: a render that drew nothing, or an
 *  extractor that read nothing, has none. */
export function dictionaryHits(segments: readonly Segment[], locale: Locale): number {
  return segments.filter((seg) => {
    if (!hasLetters(withoutData(seg.text, locale, []))) return false;
    return valueKeys(seg.text, locale, []).length > 0;
  }).length;
}

export const formatFinding = (f: Finding) =>
  `${f.kind.padEnd(9)} ${f.where.padEnd(14)} ${JSON.stringify(f.text)}${f.keys.length ? `  ← ${f.keys.slice(0, 3).join(", ")}` : ""}`;
