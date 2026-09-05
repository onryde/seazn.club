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
import { readFileSync } from "node:fs";
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
 * The modules that OWN the card bullets: the shared source both surfaces read
 * from, and the home-page stub component that renders them.
 *
 * `/[lang]/pricing/page.tsx` is deliberately NOT here. It is a 600-line page
 * whose own chrome already goes through `t(d, …)`, and widening the scan to it
 * would pull in the wider marketing tree rather than the thing this guard is
 * about. The rendered check in pricing-page.test.tsx is the net for that side.
 */
const PROSE_SCANNED = [
  "src/lib/pricing-cards.ts",
  "src/components/marketing/ticket-stubs.tsx",
] as const;

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

// ─────────────────────────────────────────────────────────────────────────────

describe("the plan-card bullets are dictionary copy, not literals (SOURCE SCAN)", () => {
  it("no module that owns a card bullet ships a user-facing literal", () => {
    expect(hardcodedProseFaults(PROSE_SCANNED)).toEqual([]);
  });

  it("every prose exemption still matches something in the scanned files", () => {
    const seen = new Set(
      PROSE_SCANNED.flatMap((f) => proseLiterals(f, readFileSync(f, "utf8"))).map((h) =>
        h.text.trim(),
      ),
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
   * into copy going stale under the row it described (V392 re-cut community's
   * active-competition cap to 3 against a card still promising 10; V395 took
   * badge removal off Pro; V397 re-cut the fee ladder; the L rung's caps
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
