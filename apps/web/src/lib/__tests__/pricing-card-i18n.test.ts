// THE PLAN-CARD BULLETS ARE DICTIONARY COPY, IN FOUR LOCALES — AND NOTHING
// RENDERED CAN PROVE IT.
//
// ── The defect ───────────────────────────────────────────────────────────────
// `FREE_FEATURES`, `PASS_FEATURES` and `PRO_FEATURES` were plain English string
// arrays rendered straight into `/[lang]/pricing` and into the home ticket
// stubs. On /es/pricing a Spanish visitor read a localised crossover sentence,
// a localised FAQ and a localised comparison matrix — and then three cards of
// English bullets. Same on /fr and /nl. It was invisible to ~14,000 passing
// tests and was found by opening the page.
//
// The shape was pre-existing and knowingly tolerated (the deleted Pro Plus
// card's own comment said its text "is fully localized, unlike the other three
// cards' hardcoded-English arrays"). What made it due was this wave CHANGING
// five of those bullets' values: "any new or changed user-facing string → all
// four locale dictionaries" (AGENTS.md).
//
// ── Why a rendered assertion is NOT the guard ────────────────────────────────
// A test that loads /es/pricing and asserts the bullets are Spanish renders
// IDENTICALLY whether the text came from a dictionary lookup or was hardcoded
// as a Spanish literal in the component. It tests the symptom. The moment
// someone pastes a Spanish string back into `pricing-cards.ts` it keeps
// passing — and the fourth locale silently rots.
//
// So the PRIMARY guard here is a SOURCE SCAN, and it is deliberately
// language-agnostic: it faults a user-facing PROSE LITERAL in the modules that
// own the card bullets, whatever language that literal is in. The rendered
// check lives in `app/[lang]/(marketing)/pricing/__tests__/pricing-page.test.tsx`
// and is explicitly the WEAKER of the two — it exists to catch English leaking
// in from somewhere this scan does not reach.
//
// `mutation-proved` below: the contrast between the two is committed, not a
// manual check that happened once.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type * as TS from "typescript";
import {
  FREE_CARD_BULLETS,
  PASS_CARD_BULLETS,
  PRO_CARD_BULLETS,
  cardBullets,
} from "@/lib/pricing-cards";
import type { MatrixData } from "@/lib/pricing-matrix";

// `typescript` is loaded through require, not import — it is a ~10 MB CJS
// bundle and vite's import-analysis pass chokes on it. Same trick as
// `pass-scoping-guard.test.ts`; the type side is erased.
const ts: typeof TS = createRequire(import.meta.url)("typescript");

const DICTIONARY_LOCALES = ["en", "es", "fr", "nl"] as const;

const marketing = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(`src/dictionaries/${locale}/marketing.json`, "utf8"));

// ─────────────────────────────────────────────────────────────────────────────
// THE KEYS
// ─────────────────────────────────────────────────────────────────────────────

/** Every bullet key the three plan cards render, in card order. Typed out here
 *  rather than imported so the module's own declaration is CHECKED against this
 *  list rather than vouching for itself — the same reason `CARD_SURFACES` in
 *  pricing-cards.test.ts is a hand-written inventory. */
const BULLET_KEYS = {
  community: ["f1", "f2", "f3", "f4", "f5", "f6"].map((n) => `pricing.community.${n}`),
  pass: ["f1", "f2", "f3", "f4", "f5", "f6", "f7"].map((n) => `pricing.pass.${n}`),
  pro: ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9"].map((n) => `pricing.pro.${n}`),
} as const;

const ALL_BULLET_KEYS = [...BULLET_KEYS.community, ...BULLET_KEYS.pass, ...BULLET_KEYS.pro];

// ─────────────────────────────────────────────────────────────────────────────
// THE SOURCE SCAN (primary)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── WHY THIS LIST IS DISCOVERED AND NOT TYPED OUT ──────────────────────
 *
 * It used to be two hand-written paths — the module that owns the card bullets,
 * and the home-page stub that renders them — and that scope is precisely what
 * let the next instance of the same defect walk straight past it.
 * `components/pro-price-card.tsx` sits on the SAME page, a few hundred pixels
 * from the bullets this scan was written for, and shipped "/month", "Annual
 * billing", "Billed monthly · switch to yearly any time" and
 * "$128.99 billed yearly — save 30%" as English literals in every locale. It was
 * even NAMED as a live finding in the commit that added this file, and naming it
 * is not covering it.
 *
 * A scan whose scope is a list of names only ever covers the components somebody
 * remembered. The one added tomorrow is the one nobody will.
 *
 * So the scope is READ OFF THE PAGE: every `@/components/…` module the pricing
 * page imports is scanned, whatever it is called and whenever it arrived. A
 * component mounted on /pricing is in scope the moment its import line lands,
 * with nobody's memory in the loop.
 *
 * `/[lang]/pricing/page.tsx` ITSELF is still deliberately NOT scanned, for the
 * reason it never was: it is a 600-line server page whose own chrome already
 * goes through `t(d, …)`, and it carries analytics ids, plan keys and matrix
 * identifiers this prose heuristic would have to be tuned down to tolerate —
 * tuned down is how a scan stops seeing real copy. The rendered check in
 * pricing-page.test.tsx is the net for that side.
 */
const PRICING_PAGE = "src/app/[lang]/(marketing)/pricing/page.tsx";

/**
 * Every `@/components/…` module a page MOUNTS, in source order.
 *
 * Type-only imports are skipped — an erased import renders nothing, so it can
 * carry no copy. A pure (file, text) pair like `proseLiterals` above, so the
 * discovery itself is provable against a fixture rather than only against the
 * one page that exists today.
 */
function componentSpecifiers(file: string, text: string): string[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  for (const stmt of src.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (stmt.importClause?.isTypeOnly) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (spec.startsWith("@/components/")) out.push(spec);
  }
  return [...new Set(out)].sort();
}

/** `@/…` is `apps/web/src/…` (tsconfig paths). `null` when nothing is there —
 *  which is a FAULT below, never a silent skip: a renamed component would
 *  otherwise drop out of the scan and take its copy with it. */
function resolveComponent(specifier: string): string | null {
  const base = `src/${specifier.slice("@/".length)}`;
  for (const ext of [".tsx", ".ts"]) {
    if (existsSync(`${base}${ext}`)) return `${base}${ext}`;
  }
  return null;
}

const PRICING_PAGE_SPECIFIERS = componentSpecifiers(
  PRICING_PAGE,
  readFileSync(PRICING_PAGE, "utf8"),
);

/** The bullet-owning module, the home stub that renders it, and every component
 *  the pricing page mounts. */
const PROSE_SCANNED: readonly string[] = [
  ...new Set([
    "src/lib/pricing-cards.ts",
    // Not reachable from the pricing page's imports — the HOME page mounts it.
    "src/components/marketing/ticket-stubs.tsx",
    ...PRICING_PAGE_SPECIFIERS.map(resolveComponent).filter((f): f is string => f !== null),
  ]),
].sort();

/**
 * Prose literals that are allowed to stay hardcoded, each with its reason.
 *
 * An exemption that matches nothing is a fault of its own (below) — that is how
 * an exemption list rots into decoration once the literal it excused is gone.
 */
const PROSE_EXEMPT: Record<string, string> = {
  "ADMIT ONE":
    "the printed-ticket motif stamped across the stub (aria-hidden, mk-stub-admit). It names nothing the product does and reads as typography rather than copy — the same standing this repo gives a decorative glyph. Localising it would translate the prop, not the message.",
};

interface ProseHit {
  file: string;
  line: number;
  text: string;
}

/**
 * Every user-facing string literal in a module, found with the TypeScript
 * parser rather than a regex.
 *
 * A regex cannot do this job here: `ticket-stubs.tsx` carries Tailwind class
 * lists that are longer and wordier than any bullet ("flex flex-wrap
 * justify-center gap-5"), and a scan that cannot tell a `className` from a text
 * node either drowns in false positives or is tuned until it stops seeing real
 * copy. The AST knows the difference structurally.
 *
 * EXCLUDED, by position rather than by content:
 *  - module specifiers (`import … from "@/lib/currency"`);
 *  - JSX attribute values of every kind — className, style, href, key, aria-*.
 *    A user-facing attribute (a real `aria-label`, a `placeholder`) would be a
 *    gap, and there is none in these two files; the rendered check is the net;
 *  - property NAMES (`{ "pricing.pro.f1": … }`);
 *  - anything that is not prose (see `isProse`).
 *
 * Exported as a pure (file, text) pair so the mutation proofs below run the
 * EXACT code under test against a fixture, rather than a re-implementation that
 * could pass while the real scan is broken.
 */
function proseLiterals(file: string, text: string): ProseHit[] {
  const src = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: ProseHit[] = [];
  const lineOf = (node: TS.Node): number =>
    src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;

  /** Is this literal sitting somewhere the user never reads? */
  const isNonUserFacing = (node: TS.Node): boolean => {
    const parent = node.parent;
    if (!parent) return false;
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
    if (ts.isImportTypeNode(parent) || ts.isCallExpression(parent)) {
      // `require("typescript")` / dynamic import specifiers.
      if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
        const fn = parent.expression.getText(src);
        if (fn === "require" || fn === "import") return true;
      }
    }
    // A property NAME, not a value.
    if (
      (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) &&
      parent.name === node
    ) {
      return true;
    }
    // A DIRECTIVE PROLOGUE — `"use client"`, `"use server"`. A bare string as a
    // whole statement is never rendered, and every client component in this
    // tree opens with one; excluded by POSITION, like the rest of this list,
    // rather than by allowlisting the two spellings.
    if (ts.isExpressionStatement(parent) && parent.expression === node) return true;
    // Any JSX attribute value: `className="…"`, and `className={`…`}` too.
    for (let p: TS.Node | undefined = parent; p; p = p.parent) {
      if (ts.isJsxAttribute(p)) return true;
      if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isSourceFile(p)) break;
    }
    return false;
  };

  const visit = (node: TS.Node): void => {
    if (ts.isJsxText(node)) {
      const trimmed = node.text.trim();
      if (trimmed) hits.push({ file, line: lineOf(node), text: trimmed });
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isNonUserFacing(node)) hits.push({ file, line: lineOf(node), text: node.text });
    } else if (ts.isTemplateExpression(node)) {
      // The literal chunks of a template: `${price} per month` still ships
      // "per month" as English.
      if (!isNonUserFacing(node)) {
        for (const span of [node.head, ...node.templateSpans.map((s) => s.literal)]) {
          const trimmed = span.text.trim();
          if (trimmed) hits.push({ file, line: lineOf(span), text: trimmed });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return hits;
}

/**
 * Is a string USER-FACING PROSE?
 *
 * Two or more word-shaped tokens, and long enough to be a sentence fragment
 * rather than an identifier. Deliberately blind to LANGUAGE — `\p{L}` matches
 * "competiciones" exactly as happily as "competitions", which is the whole
 * point: a guard that only knows English words would wave through the Spanish
 * literal someone writes when they "fix" the /es page by hand, and the other
 * three locales would rot behind it.
 *
 * A dotted key ("pricing.community.f1"), a feature key
 * ("competitions.max_active") and a plan key ("community") all have no space,
 * so they are not prose and never need exempting.
 */
function isProse(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 8) return false;
  const words = trimmed.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w));
  return words.length >= 2;
}

function hardcodedProseFaults(files: readonly string[]): string[] {
  const faults: string[] = [];
  for (const file of files) {
    for (const hit of proseLiterals(file, readFileSync(file, "utf8"))) {
      if (!isProse(hit.text)) continue;
      if (hit.text.trim() in PROSE_EXEMPT) continue;
      faults.push(`${hit.file}:${hit.line} hardcoded prose: ${JSON.stringify(hit.text)}`);
    }
  }
  return faults;
}

/**
 * ── THE ONE-WORD GAP, CLOSED STRUCTURALLY ────────────────────────────────────
 *
 * `isProse` needs TWO word-shaped tokens, which is the price of not drowning in
 * Tailwind class lists — and it is why the widened scan above, run against the
 * unfixed `pro-price-card.tsx`, reported four faults and not six. The two it
 * could not see were the worst strings on the card:
 *
 *     <span …>/month</span>                        one token
 *     <span …>save 30%</span>                      one token, and FALSE in all
 *                                                  four markets (usd 28.29%,
 *                                                  eur 30.08%, gbp 32.52%,
 *                                                  inr 30.45% on the base tier)
 *
 * `pricing-cards.ts` closes the same gap with a strict whitelist — every literal
 * must be a dictionary key or a row identifier — but that only works on a pure
 * data module. A COMPONENT is full of legitimate non-copy literals (font
 * weights, cookie attributes, ISO currency codes), so the strict rule has to be
 * narrower than "no literals".
 *
 * It is narrower by POSITION, the way everything else here is: a JSX TEXT NODE
 * is, definitionally, characters painted onto the screen. If it contains a
 * letter or a digit in any script, it is copy, and copy belongs in a dictionary.
 * A separator, a bullet glyph, a "✓", an arrow — none of those carry a letter,
 * so none of them need exempting, and the rule costs a component nothing until
 * it actually hardcodes something a reader reads.
 *
 * Language-agnostic like its neighbour, and for the same reason: `\p{L}` is as
 * happy with "Facturación mensual" as with "Billed monthly".
 */
function paintedText(file: string, text: string): ProseHit[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: ProseHit[] = [];
  const visit = (node: TS.Node): void => {
    if (ts.isJsxText(node)) {
      const trimmed = node.text.trim();
      if (trimmed && /[\p{L}\p{N}]/u.test(trimmed)) {
        hits.push({
          file,
          line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1,
          text: trimmed,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return hits;
}

function paintedTextFaults(files: readonly string[]): string[] {
  const faults: string[] = [];
  for (const file of files.filter((f) => f.endsWith(".tsx"))) {
    for (const hit of paintedText(file, readFileSync(file, "utf8"))) {
      if (hit.text in PROSE_EXEMPT) continue;
      faults.push(`${hit.file}:${hit.line} hardcoded on-screen text: ${JSON.stringify(hit.text)}`);
    }
  }
  return faults;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the plan-card bullets are dictionary copy, not literals (SOURCE SCAN)", () => {
  it("no module that owns a card bullet ships a user-facing literal", () => {
    expect(hardcodedProseFaults(PROSE_SCANNED)).toEqual([]);
  });

  /**
   * The one-word half of the same rule. Separate `it` from the prose scan on
   * purpose: the two catch different things, and a single assertion would let
   * either of them rot behind the other going red.
   */
  it("no component on the pricing page paints a literal onto the screen", () => {
    expect(paintedTextFaults(PROSE_SCANNED)).toEqual([]);
  });

  it("every prose exemption still matches something in the scanned files", () => {
    const seen = new Set(
      [
        ...PROSE_SCANNED.flatMap((f) => proseLiterals(f, readFileSync(f, "utf8"))),
        ...PROSE_SCANNED.filter((f) => f.endsWith(".tsx")).flatMap((f) =>
          paintedText(f, readFileSync(f, "utf8")),
        ),
      ].map((h) => h.text.trim()),
    );
    const stale = Object.keys(PROSE_EXEMPT).filter((t) => !seen.has(t));
    expect(stale, "exemptions covering nothing — delete them").toEqual([]);
    for (const [text, why] of Object.entries(PROSE_EXEMPT)) {
      expect(why.length, `${text} has no reason`).toBeGreaterThan(40);
    }
  });

  /**
   * ── THE CONTRAST THAT MATTERS ────────────────────────────────────────────
   *
   * The scan must red on a hardcoded bullet in EITHER language. The English
   * case is what a revert looks like; the Spanish case is what a well-meant
   * "I'll just fix the Spanish page" looks like — and it is the one a rendered
   * assertion on /es/pricing cannot see at all.
   */
  it("fires on a hardcoded bullet whatever language it is written in", () => {
    const fixture = (literal: string) =>
      `export const FREE_FEATURES = [\n  ${JSON.stringify(literal)},\n];\n`;
    for (const literal of [
      "3 active competitions, 4 divisions",
      "3 competiciones activas, 4 divisiones",
      "3 compétitions actives, 4 divisions",
      "3 actieve competities, 4 divisies",
    ]) {
      const hits = proseLiterals("fixture.ts", fixture(literal)).filter((h) => isProse(h.text));
      expect(hits.map((h) => h.text), literal).toEqual([literal]);
    }
  });

  it("does not fire on the things these modules legitimately contain", () => {
    const fixture = [
      `import { formatMinor } from "@/lib/currency";`,
      `export const KEYS = ["pricing.community.f1", "pricing.pro.f9"];`,
      `const FEATURE = "competitions.max_active";`,
      `const PLAN = "community";`,
    ].join("\n");
    expect(proseLiterals("fixture.ts", fixture).filter((h) => isProse(h.text))).toEqual([]);
  });

  it("sees through a JSX class list to the text node beside it", () => {
    const fixture =
      `export const A = () => (\n` +
      `  <p className="flex flex-wrap justify-center gap-5 text-xs">Compare plans in detail</p>\n` +
      `);\n`;
    const hits = proseLiterals("fixture.tsx", fixture).filter((h) => isProse(h.text));
    expect(hits.map((h) => h.text)).toEqual(["Compare plans in detail"]);
  });

  /**
   * The same contrast, on CARD CHROME rather than a bullet — the shape that
   * actually shipped. A price suffix and a saving badge are JSX TEXT NODES
   * beside a class list, not entries in an exported array, so this proves the
   * widened scope is watching the thing that broke rather than a second copy of
   * the case already covered above.
   *
   * The French row is the one that matters. A rendered assertion on /fr/pricing
   * is fully green on it — measured, twice now — because a dictionary lookup and
   * a hardcoded translation emit the same bytes.
   */
  it("fires on hardcoded card chrome, whatever language it is written in", () => {
    const fixture = (literal: string) =>
      `export const C = () => (\n  <p className="mb-3 text-sm text-slate-500">${literal}</p>\n);\n`;
    for (const literal of [
      "$128.99 billed yearly — save 30%",
      "Billed monthly · switch to yearly any time",
      "128,99 € facturé à l'année — plus de deux mois offerts",
      "Facturación mensual · cambia a anual cuando quieras",
      "Maandelijkse facturering · stap altijd over op jaarlijks",
    ]) {
      const hits = proseLiterals("fixture.tsx", fixture(literal)).filter((h) => isProse(h.text));
      expect(hits.map((h) => h.text), literal).toEqual([literal]);
    }
  });

  /**
   * ── AND THE TWO STRINGS THE PROSE HEURISTIC CANNOT SEE ───────────────────
   *
   * "/month" and "save 30%" are ONE word-shaped token each, so `isProse`
   * returns false for both and the scan above reports them as clean. They are
   * also the price suffix and the discount badge — the most claim-bearing copy
   * on the card, and "save 30%" was outright false in all four markets.
   *
   * Measured, against the component as it shipped: the widened prose scan found
   * four of the six hardcoded strings. These are the other two.
   */
  it("catches one-word chrome the prose heuristic is structurally blind to", () => {
    const fixture = (literal: string) =>
      `export const C = () => (\n  <span className="text-lg font-normal">${literal}</span>\n);\n`;
    for (const literal of ["/month", "save 30%", "/mois", "/maand", "Pro"]) {
      expect(isProse(literal), `${literal} should NOT be prose — that is the gap`).toBe(false);
      expect(
        paintedText("fixture.tsx", fixture(literal)).map((h) => h.text),
        literal,
      ).toEqual([literal]);
    }
  });

  /**
   * …and it must NOT fire on the punctuation and glyphs a localised card
   * legitimately paints between two dictionary strings, or the rule is
   * unaffordable and the next person turns it off.
   */
  it("ignores separators and glyphs, which carry no letter to translate", () => {
    const fixture =
      `export const C = () => (\n` +
      `  <p className="mb-3">\n` +
      `    <span aria-hidden>⚡</span>\n` +
      `    {billed} — <span className="font-semibold">{saving}</span>\n` +
      `    <span className="mt-0.5">✓</span> {bullet}\n` +
      `  </p>\n` +
      `);\n`;
    expect(paintedText("fixture.tsx", fixture)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SCOPE ITSELF (a scan is only as good as the list of files it opens)
// ─────────────────────────────────────────────────────────────────────────────

describe("the scan's scope is discovered from the page, not remembered", () => {
  /**
   * The defect this widening exists for: a component on the pricing page that
   * the hand-written list did not name. Pinned BY NAME here — not because the
   * list is hand-written again, but because an anti-vacuity check that only
   * counts entries passes on a discovery that collapsed to the two seeds.
   */
  it("reaches the components the pricing page actually mounts", () => {
    expect(PROSE_SCANNED).toContain("src/components/pro-price-card.tsx");
    expect(PROSE_SCANNED).toContain("src/components/currency-switcher.tsx");
    expect(PROSE_SCANNED).toContain("src/lib/pricing-cards.ts");
    expect(PROSE_SCANNED).toContain("src/components/marketing/ticket-stubs.tsx");
    expect(PROSE_SCANNED.length, "the discovery collapsed to its seeds").toBeGreaterThan(4);
  });

  /**
   * A specifier that resolves to nothing is a FAULT, not a skip. Rename a
   * component and the naive version of this discovery quietly scans one file
   * fewer, which is the same failure as the hand-written list wearing a
   * different hat.
   */
  it("resolves every component import it found, or says which it could not", () => {
    const unresolved = PRICING_PAGE_SPECIFIERS.filter((s) => resolveComponent(s) === null);
    expect(unresolved, "a component import resolving to no file — the scan silently shrank").toEqual(
      [],
    );
    expect(PRICING_PAGE_SPECIFIERS.length, "no component imports found at all").toBeGreaterThan(2);
    for (const file of PROSE_SCANNED) expect(existsSync(file), file).toBe(true);
  });

  /**
   * ── THE POINT OF THE WIDENING ────────────────────────────────────────────
   *
   * A component added to the page tomorrow is in scope tomorrow. Proved against
   * a FIXTURE, so it is a property of the discovery rather than of today's page:
   * an unknown component is picked up, `@/lib` is not, and a type-only import
   * (erased at build, renders nothing, can carry no copy) is not.
   */
  it("picks up a component the day its import line lands", () => {
    const fixture = [
      `import type { Metadata } from "next";`,
      `import { MarketingShell } from "@/components/marketing/marketing-shell";`,
      `import { SomethingNobodyHasWrittenYet } from "@/components/brand-new-card";`,
      `import { formatMinor } from "@/lib/currency";`,
      `import type { Currency } from "@/components/erased-type-only";`,
    ].join("\n");
    expect(componentSpecifiers("fixture.tsx", fixture)).toEqual([
      "@/components/brand-new-card",
      "@/components/marketing/marketing-shell",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE DICTIONARY SIDE
// ─────────────────────────────────────────────────────────────────────────────

describe("the plan-card bullet keys are real, translated, four-locale copy", () => {
  it("every bullet key exists in all four locales, as a non-empty string", () => {
    for (const locale of DICTIONARY_LOCALES) {
      const dict = marketing(locale);
      for (const key of ALL_BULLET_KEYS) {
        // FLAT lookup: these dictionaries are flat dotted-key JSON, and a
        // nested walk false-negatives on them.
        expect(dict, `${locale} ${key}`).toHaveProperty(key);
        expect(typeof dict[key], `${locale} ${key}`).toBe("string");
        expect(dict[key]!.length, `${locale} ${key}`).toBeGreaterThan(0);
      }
    }
    expect(ALL_BULLET_KEYS.length).toBe(22);
  });

  /**
   * GENUINELY TRANSLATED, not English copied into four files.
   *
   * `getDictionary` merges every locale over `en`, so a key that is simply
   * MISSING from es/fr/nl renders English with no error anywhere — and
   * `i18n:check` passes on a byte-identical placeholder because parity checks
   * KEYS, not content. This is the only rule that can tell the difference.
   */
  it("es, fr and nl differ from en on every bullet", () => {
    const en = marketing("en");
    const untranslated: string[] = [];
    for (const locale of DICTIONARY_LOCALES.filter((l) => l !== "en")) {
      const dict = marketing(locale);
      for (const key of ALL_BULLET_KEYS) {
        if (dict[key] === en[key]) untranslated.push(`${locale} ${key}`);
      }
    }
    expect(untranslated, "English copied into a locale file").toEqual([]);
  });

  /**
   * ── NO NUMBER MAY BE FROZEN INTO THE COPY ────────────────────────────────
   *
   * Every figure these bullets quote is a matrix claim: the community/pass/pro
   * entrant, division and active-competition caps, and the three platform-fee
   * rates. This wave has already fixed FOUR separate cases of a number typed
   * into copy going stale under the row it described (V393 re-cut community's
   * active-competition cap to 3 against a card still promising 10; V396 took
   * badge removal off Pro; V398 re-cut the fee ladder; the L rung's caps
   * survived its withdrawal). A number typed into FOUR locale files goes stale
   * four times and is fixed once.
   *
   * So: no digit, anywhere, in any locale. Every number arrives through a
   * placeholder that `cardBullets` fills from `plan_entitlements`.
   */
  it("freezes no number into any locale — every figure is a placeholder", () => {
    const faults: string[] = [];
    for (const locale of DICTIONARY_LOCALES) {
      const dict = marketing(locale);
      for (const key of ALL_BULLET_KEYS) {
        const value = dict[key] ?? "";
        if (/\d/.test(value)) faults.push(`${locale} ${key}: "${value}" quotes a literal number`);
      }
    }
    expect(faults).toEqual([]);
  });

  /**
   * …and the placeholders themselves must agree across the four locales.
   *
   * A translator who drops `{entrants}` produces a bullet that is grammatical,
   * looks finished, and quietly stops naming the cap. `interpolate` leaves an
   * UNKNOWN `{name}` in the output verbatim, so the reverse — a translator who
   * invents `{participants}` — ships a literal "{participants}" onto the page.
   * Both are invisible to a locale-by-locale read and obvious as a set diff.
   */
  it("carries the same placeholder set in every locale", () => {
    const en = marketing("en");
    const vars = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    const faults: string[] = [];
    for (const key of ALL_BULLET_KEYS) {
      const expected = vars(en[key]!);
      for (const locale of DICTIONARY_LOCALES.filter((l) => l !== "en")) {
        const got = vars(marketing(locale)[key] ?? "");
        if (got.join(",") !== expected.join(",")) {
          faults.push(`${locale} ${key}: placeholders [${got}] against en [${expected}]`);
        }
      }
    }
    expect(faults).toEqual([]);
    // Anti-vacuity: this rule is worthless unless some bullet actually has one.
    const withVars = ALL_BULLET_KEYS.filter((k) => vars(en[k]!).length > 0);
    expect(withVars.length, "no bullet interpolates anything — the numbers went back into the copy").toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE CODE AND THE COPY MUST DESCRIBE THE SAME BULLETS
// ─────────────────────────────────────────────────────────────────────────────

describe("pricing-cards.ts and the dictionaries agree", () => {
  const DECLARED = {
    community: FREE_CARD_BULLETS,
    pass: PASS_CARD_BULLETS,
    pro: PRO_CARD_BULLETS,
  } as const;

  it("declares exactly the keys this file inventories, in card order", () => {
    for (const card of ["community", "pass", "pro"] as const) {
      expect(DECLARED[card].map((b) => b.key), card).toEqual(BULLET_KEYS[card]);
    }
  });

  /**
   * A placeholder the code never fills renders VERBATIM — `interpolate` leaves
   * an unknown `{name}` in the output — so "{entrants} entrants per division"
   * would ship onto a buyer's card. The reverse, a var the code supplies that
   * no locale uses, is a wire to nowhere: the row moves and the copy does not.
   * Both are silent; both are a set diff.
   */
  it("supplies exactly the placeholders the English copy asks for", () => {
    const en = marketing("en");
    const faults: string[] = [];
    for (const card of ["community", "pass", "pro"] as const) {
      for (const bullet of DECLARED[card]) {
        const wanted = [...(en[bullet.key as string] ?? "").matchAll(/\{(\w+)\}/g)]
          .map((m) => m[1]!)
          .sort();
        const supplied = Object.keys(bullet.vars ?? {}).sort();
        if (wanted.join(",") !== supplied.join(",")) {
          faults.push(`${bullet.key}: copy wants [${wanted}], code supplies [${supplied}]`);
        }
      }
    }
    expect(faults).toEqual([]);
  });

  /**
   * ── FAIL SOFT, NOT HALF-RENDERED ─────────────────────────────────────────
   *
   * `loadPricingMatrix` fails soft to `{}` when the DB is unreachable at build,
   * and a null `int_value` legitimately means UNLIMITED — a value no cap
   * sentence can render. Either way the bullet is dropped, which is the rule
   * the M/L ladder on the same card already follows ("absence must suppress the
   * block, not embellish it"). The alternative is a literal "{entrants}" on a
   * marketing page.
   */
  it("drops a bullet it cannot fill rather than printing a placeholder", () => {
    const en = marketing("en");
    const full: MatrixData = {
      "competitions.max_active": { community: { bool_value: null, int_value: 3 } },
      "divisions.per_competition.max": { community: { bool_value: null, int_value: 4 } },
      "entrants.per_division.max": { community: { bool_value: null, int_value: 64 } },
      "registration.fee_percent": { community: { bool_value: null, int_value: 5 } },
    };
    const rendered = cardBullets(en, FREE_CARD_BULLETS, full);
    expect(rendered.length, "every Community bullet should render from a complete matrix").toBe(6);
    expect(rendered.join(" | ")).not.toMatch(/[{}]/);

    // A missing row, and a NULL row, each take their bullet with them.
    const broken: MatrixData[] = [
      { ...full, "entrants.per_division.max": {} },
      { ...full, "entrants.per_division.max": { community: { bool_value: null, int_value: null } } },
    ];
    for (const matrix of broken) {
      const out = cardBullets(en, FREE_CARD_BULLETS, matrix);
      expect(out.length, "the entrant bullet must drop").toBe(5);
      expect(out.join(" | "), "no half-rendered copy").not.toMatch(/[{}]/);
    }

    // …and an empty matrix leaves ONLY the bullets that quote nothing, rather
    // than six lines of braces.
    const dark = cardBullets(en, FREE_CARD_BULLETS, {});
    expect(dark.length).toBe(3);
    expect(dark.join(" | ")).not.toMatch(/[{}]/);
  });

  /**
   * ── THE WHITELIST, on the module that owns the bullets ───────────────────
   *
   * The prose scan above is a heuristic: it needs two word-shaped tokens, so a
   * ONE-WORD label ("Community", "/mo") slips past it. `pricing-cards.ts` is
   * now a pure data module whose every string literal is either a dictionary
   * key or a `plan_entitlements` identifier, so it can afford the strict rule —
   * and the strict rule is what catches the tier names and the price suffixes
   * that the prose heuristic cannot see. Measured: before this wave the module
   * carried "Community", "Event Pass", "Pro", " once" and "/mo" as literals,
   * and only ONE of those five is prose by the heuristic's definition.
   */
  it("pricing-cards.ts carries no literal that is not a key or a row identifier", () => {
    const file = "src/lib/pricing-cards.ts";
    const dict = marketing("en");
    const PLAN_KEY = /^(community|event_pass|event_pass_l|pro|enterprise)$/;
    const FEATURE_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
    /** The two literals in the module that are neither, each with its reason.
     *  A stale entry is a fault below — an allowlist nobody prunes is how a
     *  strict rule turns back into a loose one. */
    const CODE_IDENTIFIERS: Record<string, string> = {
      number:
        "the operand of `typeof value !== \"number\"` in cardBullets — the guard that decides whether a matrix cell is readable",
      monthly:
        "the billing INTERVAL passed to proPrice(), a key into config/stripe-plans.json. An identifier in a price lookup, not a word anybody reads",
    };
    const faults: string[] = [];
    for (const hit of proseLiterals(file, readFileSync(file, "utf8"))) {
      const text = hit.text;
      if (text in dict) continue;
      if (PLAN_KEY.test(text)) continue;
      if (FEATURE_KEY.test(text)) continue;
      if (text in CODE_IDENTIFIERS) continue;
      faults.push(`${hit.file}:${hit.line} ${JSON.stringify(text)} is neither a dictionary key nor a plan_entitlements identifier`);
    }
    expect(faults).toEqual([]);
    // Anti-vacuity: the scan must actually be finding the keys, or this rule
    // passes on a module it never opened.
    const literals = proseLiterals(file, readFileSync(file, "utf8"));
    expect(
      literals.filter((h) => h.text in dict).length,
      "found no dictionary keys in pricing-cards.ts",
      // 22 bullets + the three tier names, the "from" qualifier, "Free", and
      // the two stub price suffixes. A COUNT, not a floor: a bullet quietly
      // dropped from a card reds here as well as in the approved-wording gate.
    ).toBe(29);
    const seenText = new Set(literals.map((h) => h.text));
    expect(
      Object.keys(CODE_IDENTIFIERS).filter((k) => !seenText.has(k)),
      "allowlisted identifiers that are no longer in the module",
    ).toEqual([]);
    for (const [text, why] of Object.entries(CODE_IDENTIFIERS)) {
      expect(why.length, `${text} has no reason`).toBeGreaterThan(40);
    }
  });
});
