// NO SHIPPED USER-FACING STRING MAY NAME A PLAN NOBODY CAN BUY.
//
// This file exists because the repo has already demonstrated that it has no
// such rule. V392 deleted `pro_plus` from `plans`; the guard that would have
// noticed — `plusDifferentiatorFaults` — was deleted in the same wave, because
// it judged whether a Pro Plus differentiator was exclusive and there was no
// longer a Pro Plus. Nothing replaced it. `/pricing` went on answering "What's
// in Pro Plus?" in four languages, seventeen help articles went on selling it,
// and one in-app button POSTed `plan_key=pro_plus` at an API that can no longer
// honour it — through a green suite of roughly 13,800 tests.
//
// ONE HOME, ON PURPOSE. `dictionary-copy-truth` owns the dictionaries and
// `help-copy-truth` owns the help tree, and this claim spans both plus
// `config/tips.ts`. Split across two files it would have been pointed at one
// corpus and not the other, which is the exact failure mode both of those files
// record having shipped (a rule that existed, and nothing pointed at the key).
//
// LOCATION IS LOAD-BEARING: `src/lib/__tests__/`, like its two siblings. CI's
// unit job has no DATABASE_URL and its Postgres steps select `src/server`,
// `src/lib` and `src/app` — the DB half below would run in no job at all from
// anywhere else.
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { sql } from "@/lib/db";
import { ALL_PLAN_KEYS } from "@/lib/currency";
import { RETIRED_PLAN_KEYS, planLabel } from "@/lib/plan-label";
import { TIPS } from "@/config/tips";
import { allHelpArticles } from "@/server/help-content";
import {
  DICTIONARY_LOCALES,
  type DictionaryLocale,
  type LocalisedValue,
  type RetiredPlanExemption,
  retiredPlanNameFaults,
  retiredPlanNameHits,
  staleRetiredPlanExemptions,
} from "@/lib/copy-truth";
import { helpArticleBySlug } from "./_help-copy";

const HAS_DB = !!process.env.DATABASE_URL;

afterAll(async () => {
  if (!HAS_DB) return;
  const globalForDb = globalThis as { _sql?: { end(): Promise<void> } };
  const client = globalForDb._sql;
  globalForDb._sql = undefined;
  await client?.end();
});

// ── THE VOCABULARY, DERIVED ─────────────────────────────────────────────────
//
// `plans.name` is the authority on what exists, and the rule is its negative: a
// plan-name-shaped phrase that is not in it has no business in copy. Derived
// here from `ALL_PLAN_KEYS` through the same `planLabel` the product renders
// with, so nothing in this file hand-types a plan name — and cross-checked
// against the live table below, which is what makes the derivation a fact
// rather than a second opinion.
const LIVE_PLAN_NAMES = ALL_PLAN_KEYS.map((key) => planLabel(key));
const RETIRED_PLAN_NAMES = RETIRED_PLAN_KEYS.map(({ key }) => planLabel(key));

// ── THE CORPUS: everything a customer can read ───────────────────────────────

/** Every dictionary value, every locale, every file — a directory walk, not a
 *  list of filenames. A new dictionary file joins the scan by existing. */
const dictionaryValues = (): LocalisedValue[] => {
  const values: LocalisedValue[] = [];
  for (const locale of DICTIONARY_LOCALES) {
    const dir = `src/dictionaries/${locale}`;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const dict: Record<string, unknown> = JSON.parse(readFileSync(`${dir}/${file}`, "utf8"));
      for (const [key, value] of Object.entries(dict)) {
        if (typeof value === "string") values.push({ locale, key, value });
      }
    }
  }
  return values;
};

/** `config/tips.ts` is NOT what renders — `components/ui/tip.tsx` reads the
 *  dictionaries — but it is the source the en dictionary mirrors, so a retired
 *  plan left here is one edit away from shipping again. Scanned as its own
 *  surface for that reason, and separately from the mirror assertion in
 *  dictionary-copy-truth.test.ts, which allows documented exceptions. */
const tipValues = (): LocalisedValue[] =>
  Object.entries(TIPS).flatMap(([id, tip]) =>
    (["title", "body"] as const).map((field) => ({
      locale: "en" as DictionaryLocale,
      key: `config/tips.ts tips.${id}.${field}`,
      value: tip[field],
    })),
  );

/** The whole help tree, article by article — English-only by policy. */
const helpValues = (): LocalisedValue[] =>
  [...allHelpArticles().values()].map((article) => ({
    locale: "en" as DictionaryLocale,
    key: `content/help/${article.slug}.md`,
    value: helpArticleBySlug(article.slug),
  }));

const CORPUS = [...dictionaryValues(), ...tipValues(), ...helpValues()];

// ── THE EXEMPTIONS ───────────────────────────────────────────────────────────
//
// Every one of these still says "Pro Plus", and every one of them QUOTES MONEY.
// The ruling on the sweep that added this guard is that priced copy belongs to
// the repricing that follows it — platform fees move to an additive ladder and
// subscription prices to charm endings, so a rename now is a rewrite twice. A
// plan RENAME was available for the fee-ladder rows and was taken everywhere it
// left the number alone; it is not available here, because these sentences
// quote prices that belonged to the retired plan ALONE ($39/mo, $19/mo,
// $163/yr, and a worked example built on them). There is no true rename of
// "Pro Plus is $39/month".
//
// `hits` is a COUNT, and `staleRetiredPlanExemptions` asserts it exactly: fix
// one of the four in groups.md and this list reds until someone re-counts it.
const EXEMPT: readonly RetiredPlanExemption[] = [
  {
    where: "tips.registration.platform-fee.body",
    name: "Pro Plus",
    hits: 4,
    why: "the platform-fee ladder in the registration tip, one hit per locale. Owner ruling on the retired-plan sweep: leave the fee percentages for the repricing task",
  },
  {
    where: "config/tips.ts tips.registration.platform-fee.body",
    name: "Pro Plus",
    hits: 1,
    why: "the en source the tip above mirrors. It has to move in the same change as the four dictionary values, so it carries the same exemption",
  },
  {
    where: "content/help/registration/open-registration.md",
    name: "Pro Plus",
    hits: 1,
    why: "the fee ladder inline in the payment-method list. Owner ruling: leave the fee percentages for the repricing task",
  },
  {
    where: "content/help/getting-started/create-your-organisation.md",
    name: "Pro Plus",
    hits: 2,
    why: "the fee ladder in step 2, and the organisation allowance in the FAQ below it — which states the half-rate rider and is inventory-gated (APPROVED_CREATE_ORG_INVENTORY). Owner ruling: leave this article to the repricing task",
  },
  {
    where: "content/help/billing/groups.md",
    name: "Pro Plus",
    // FIVE, not four. The first bullet says it TWICE — "Pro Plus is $39/month
    // plus $19/month each" and "Eight clubs on Pro Plus annually" — and a
    // line-counting sweep of this article read it as four. The count is the
    // guard's, derived from the scan, and it caught that miscount on its first
    // run; that is the argument for counting occurrences rather than surfaces.
    hits: 5,
    why: "the $39/$19 monthly and $327/$163 annual rider prices, the eight-club break-even worked example built on them, and the two add-an-organisation bullets. Every one quotes a price the retired plan alone had; rebuilding the arithmetic on Pro is the repricing task's, not a rename",
  },
];

describe("no shipped string names a plan nobody can buy", () => {
  // ANTI-VACUITY, and the reason this block is first. Every assertion below is
  // a scan, and a scan of nothing returns []. These are the inputs, floored.
  it("is scanning the whole shipped corpus", () => {
    for (const locale of DICTIONARY_LOCALES) {
      const forLocale = CORPUS.filter((v) => v.locale === locale && !v.key.includes("/"));
      expect(forLocale.length, `${locale}: no dictionary values reached the scan`).toBeGreaterThan(
        2000,
      );
    }
    expect(
      CORPUS.filter((v) => v.key.startsWith("content/help/")).length,
      "no help articles reached the scan",
    ).toBeGreaterThan(60);
    expect(
      CORPUS.filter((v) => v.key.startsWith("config/tips.ts")).length,
      "no tips reached the scan",
    ).toBeGreaterThan(50);
    for (const value of CORPUS) {
      expect(typeof value.value, `${value.key} is not a string`).toBe("string");
    }
    // …and the vocabulary itself. A single-name vocabulary would make the
    // qualifier scan fire on almost nothing; an empty registry disables layer B
    // outright. Both are floored inside the guard too, and asserted here so the
    // failure names the cause rather than the symptom.
    expect(LIVE_PLAN_NAMES).toEqual(["Community", "Event Pass", "Event Pass L", "Pro", "Enterprise"]);
    expect(RETIRED_PLAN_NAMES).toEqual(["Pro Plus", "Business"]);
  });

  it("names no retired or invented plan, in any locale, tip or help article", () => {
    expect(
      retiredPlanNameFaults(CORPUS, LIVE_PLAN_NAMES, RETIRED_PLAN_NAMES, EXEMPT),
    ).toEqual([]);
  });

  // The other direction, and the one that keeps the list above honest: an
  // exemption whose string has since been repaired is a standing licence for
  // the falsehood to come back on that exact surface.
  it("carries no exemption that has outlived its string", () => {
    expect(
      staleRetiredPlanExemptions(CORPUS, LIVE_PLAN_NAMES, RETIRED_PLAN_NAMES, EXEMPT),
    ).toEqual([]);
  });

  // ── PROVING THE GUARD, by construction rather than by reverting ────────────
  //
  // The corpus above is (and must stay) clean, so the assertion passes whether
  // or not the rule covers anything. These point the same pure function at the
  // copy a future editor plausibly writes.

  it("reds on the exact strings this sweep deleted", () => {
    const restored: LocalisedValue[] = [
      { locale: "en", key: "pricing.faq.proPlus.q", value: "What's in Pro Plus?" },
      { locale: "fr", key: "billing.cta.goPlus", value: "Passer à Pro Plus" },
    ];
    const faults = retiredPlanNameFaults(restored, LIVE_PLAN_NAMES, RETIRED_PLAN_NAMES, EXEMPT);
    expect(faults).toHaveLength(2);
    expect(faults.join(" ")).toContain("pricing.faq.proPlus.q");
    expect(faults.join(" ")).toContain("billing.cta.goPlus");
  });

  // LAYER A IS DERIVED, NOT A DENYLIST. The point of extending a live name is
  // that it catches the NEXT invented tier, not only the last retired one — so
  // a name nobody has ever shipped must red exactly as loudly.
  it("reds on a tier that has never existed, in any locale", () => {
    const invented: LocalisedValue[] = [
      { locale: "en", key: "k1", value: "Upgrade to Pro Elite for unlimited everything." },
      { locale: "es", key: "k2", value: "Community Premium incluye más." },
      { locale: "nl", key: "k3", value: "Event Pass Unlimited dekt alles." },
    ];
    const faults = retiredPlanNameFaults(invented, LIVE_PLAN_NAMES, RETIRED_PLAN_NAMES, EXEMPT);
    expect(faults.join(" ")).toContain("Pro Elite");
    expect(faults.join(" ")).toContain("Community Premium");
    expect(faults.join(" ")).toContain("Event Pass Unlimited");
  });

  // LAYER B, which layer A cannot reach: `business` (V290) is not an extension
  // of any live name, so only the registry finds it.
  it("reds on a retired plan whose name extends nothing live", () => {
    const faults = retiredPlanNameFaults(
      [{ locale: "en", key: "k", value: "The Business plan covers ten organisations." }],
      LIVE_PLAN_NAMES,
      RETIRED_PLAN_NAMES,
      EXEMPT,
    );
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("Business");
  });

  // …and it does not fire on the copy that is CORRECT, which is the half that
  // decides whether anyone can live with it. Every one of these is a real
  // sentence shape from the four dictionaries.
  it("stays silent on live plans, sentence ends and ordinary capitalised prose", () => {
    const truthful: LocalisedValue[] = [
      { locale: "en", key: "a", value: "8% on Community, 5% with an Event Pass, 2% on Pro." },
      { locale: "en", key: "b", value: "Public cards need Pro or an Event Pass on that competition." },
      { locale: "en", key: "c", value: "Community holds 1 and Pro holds 5. Beyond five, talk to us." },
      { locale: "en", key: "d", value: "Your Pro access continues until the end of the period." },
      { locale: "en", key: "e", value: "Enterprise adds unlimited scale and a write API." },
      { locale: "en", key: "f", value: "The Event Pass L rung covers 512 entrants." },
      { locale: "fr", key: "g", value: "Pro est à 12 $/mois. Stripe facture ses frais à part." },
      { locale: "nl", key: "h", value: "Add-ons zijn beschikbaar bij Pro. Upgrade om verder te gaan." },
    ];
    expect(retiredPlanNameFaults(truthful, LIVE_PLAN_NAMES, RETIRED_PLAN_NAMES, EXEMPT)).toEqual([]);
  });

  // The exemption is a licence for the occurrences that EXIST. One more reds.
  it("reds on a new occurrence added to an exempted surface", () => {
    const groups = CORPUS.find((v) => v.key === "content/help/billing/groups.md")!;
    const withOneMore: LocalisedValue[] = [
      { ...groups, value: `${groups.value}\n\nPro Plus is back, apparently.\n` },
    ];
    const faults = retiredPlanNameFaults(withOneMore, LIVE_PLAN_NAMES, RETIRED_PLAN_NAMES, EXEMPT);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("6 time(s), 5 exempted");
  });

  // …and one fewer reds too, which is what stops the list rotting.
  it("reds on an exemption whose string has been repaired", () => {
    const groups = CORPUS.find((v) => v.key === "content/help/billing/groups.md")!;
    const repaired = CORPUS.map((v) =>
      v.key === groups.key ? { ...v, value: v.value.replace(/Pro Plus/g, "Enterprise") } : v,
    );
    const stale = staleRetiredPlanExemptions(
      repaired,
      LIVE_PLAN_NAMES,
      RETIRED_PLAN_NAMES,
      EXEMPT,
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain("content/help/billing/groups.md");
    expect(stale[0]).toContain("5 time(s), but that surface names it 0 time(s)");
  });

  // THE VACUITY MODES, each demonstrated rather than asserted. All three inputs
  // can be emptied by an ordinary refactor — a renamed export, a directory walk
  // that stops matching, a registry someone tidies — and each would leave every
  // assertion above reporting clean.
  it("refuses to run on an empty vocabulary, registry or corpus", () => {
    expect(retiredPlanNameFaults(CORPUS, [], RETIRED_PLAN_NAMES, EXEMPT)[0]).toContain(
      "would examine nothing",
    );
    expect(retiredPlanNameFaults(CORPUS, LIVE_PLAN_NAMES, [], EXEMPT)[0]).toContain(
      "layer B would examine nothing",
    );
    expect(retiredPlanNameFaults([], LIVE_PLAN_NAMES, RETIRED_PLAN_NAMES, EXEMPT)[0]).toContain(
      "pass vacuously",
    );
  });

  // A FLOOR ON WHAT THE SCAN SEES. The two rules above are negative — they
  // report what is wrong — so a corpus the regex silently stopped matching
  // reads identically to a clean one. The exempted surfaces are the known
  // positives, and their count is asserted from the corpus rather than from
  // the list that exempts them.
  it("still finds the offences it knowingly permits", () => {
    const hits = retiredPlanNameHits(CORPUS, LIVE_PLAN_NAMES, RETIRED_PLAN_NAMES);
    expect(hits.length, "the scan found nothing at all — it is inert").toBe(
      EXEMPT.reduce((sum, e) => sum + e.hits, 0),
    );
    expect(new Set(hits.map((h) => h.name))).toEqual(new Set(["Pro Plus"]));
  });
});

// ── AND THE DERIVATION IS A FACT, NOT A SECOND OPINION ───────────────────────
//
// Everything above rests on `ALL_PLAN_KEYS` being what `plans` holds. That is
// pinned in `src/server/__tests__/retired-matrix-keys.test.ts`, which runs in a
// different job selection; re-asserted here so this file cannot certify copy
// against a vocabulary that has drifted from the table it claims to be.
describe.skipIf(!HAS_DB)("the vocabulary this file scans with is the plans table", () => {
  it("derives every live plan name from a row that exists", async () => {
    const rows = await sql<{ key: string; name: string }[]>`select key, name from plans`;
    expect(rows.length, "no plans rows at all — every scan above is vacuous").toBeGreaterThan(2);
    expect(rows.map((r) => r.key).sort()).toEqual([...ALL_PLAN_KEYS].sort());
    // `planLabel` is what the product renders; `plans.name` is what the seed
    // holds. There is no drift guard between the two anywhere else — see the
    // note in lib/plan-label.ts — and this file depends on their agreeing.
    for (const row of rows) {
      expect(planLabel(row.key), `plans.name disagrees with planLabel for ${row.key}`).toBe(row.name);
    }
  });

  it("holds no row for any plan the registry calls retired", async () => {
    for (const { key, retiredBy } of RETIRED_PLAN_KEYS) {
      const [row] = await sql<{ n: number }[]>`select count(*)::int as n from plans where key = ${key}`;
      expect(row!.n, `${key} is back in plans, but the copy registry calls it retired (${retiredBy})`).toBe(0);
    }
  });
});
