// NO SHIPPED USER-FACING STRING MAY NAME A PLAN NOBODY CAN BUY.
//
// This file exists because the repo has already demonstrated that it has no
// such rule. V393 deleted `pro_plus` from `plans`; the guard that would have
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

// ── THE EXEMPTIONS: NONE, AS OF W3 ──────────────────────────────────────────
//
// This list held five entries and is now EMPTY, which is the point of it.
//
// The sweep that added this guard found five surfaces that still said "Pro
// Plus" and could not be renamed, because every one of them QUOTED MONEY that
// belonged to the retired plan alone — $39/mo, $19/mo, $163/yr, a fee ladder
// ending "1% on Pro Plus", and an eight-club worked example built on those
// numbers. There is no true rename of "Pro Plus is $39/month". The owner's
// ruling was that priced copy belongs to the repricing that follows, so the
// five were exempted WITH A COUNT rather than half-fixed.
//
// W3 (2026-09-04) is that repricing: V398 re-cut the fee ladder for the
// additive model and every SKU moved onto charm points, so all five sentences
// were rewritten against final numbers in one change — the fee ladders now end
// "1% on Enterprise" (the row V393 moved, at the rate it kept), and groups.md's
// worked example is rebuilt on Pro's own five-organisation cap at the new
// prices. Nothing is left to permit.
//
// The list stays here, empty, rather than being deleted along with its type:
// the machinery it feeds is still the thing that keeps the NEXT deferral
// honest, and the cases below prove that machinery on synthetic surfaces
// precisely so it cannot rot while nothing live exercises it.
const EXEMPT: readonly RetiredPlanExemption[] = [];

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

  // ── THE EXEMPTION MACHINERY, PROVEN ON SYNTHETIC SURFACES ─────────────────
  //
  // These three cases used to run against the live exempted surfaces. W3
  // repriced every one of them, so `EXEMPT` is empty and there is nothing live
  // left to point at. That is a better world and a worse test: with no
  // exemption in the tree, the counting rule — the part that stops a deferral
  // becoming a permanent licence — would be dead code nobody exercises until
  // the next wave defers something and finds it broken.
  //
  // So the fixture below is a stand-in for a deferral: one surface, named three
  // times, exempted for three. It is deliberately NOT wired into the live scan.
  const DEFERRED = {
    locale: "en" as const,
    key: "content/help/billing/some-deferred-article.md",
    value: [
      "Pro Plus is $39/month.",
      "A second organisation on Pro Plus is $19/month.",
      "Eight clubs on Pro Plus annually come to $1,468.",
    ].join("\n"),
  };
  const DEFERRED_EXEMPT: readonly RetiredPlanExemption[] = [
    {
      where: DEFERRED.key,
      name: "Pro Plus",
      hits: 3,
      why: "a stand-in for a priced sentence a wave has deliberately deferred — the shape the five real ones had before W3 rewrote them",
    },
  ];

  it("permits exactly the occurrences an exemption counts, and no more", () => {
    // The licence itself: three named, three exempted, nothing reported.
    expect(
      retiredPlanNameFaults([DEFERRED], LIVE_PLAN_NAMES, RETIRED_PLAN_NAMES, DEFERRED_EXEMPT),
    ).toEqual([]);
    // …and it is a licence for the occurrences that EXIST. One more reds.
    const withOneMore: LocalisedValue[] = [
      { ...DEFERRED, value: `${DEFERRED.value}\n\nPro Plus is back, apparently.\n` },
    ];
    const faults = retiredPlanNameFaults(
      withOneMore,
      LIVE_PLAN_NAMES,
      RETIRED_PLAN_NAMES,
      DEFERRED_EXEMPT,
    );
    expect(faults).toHaveLength(1);
    expect(faults[0]).toContain("4 time(s), 3 exempted");
  });

  // …and one fewer reds too, which is what stops the list rotting — and is
  // precisely what W3 had to answer for when it repaired all five real ones.
  it("reds on an exemption whose string has been repaired", () => {
    const repaired = [{ ...DEFERRED, value: DEFERRED.value.replace(/Pro Plus/g, "Enterprise") }];
    const stale = staleRetiredPlanExemptions(
      repaired,
      LIVE_PLAN_NAMES,
      RETIRED_PLAN_NAMES,
      DEFERRED_EXEMPT,
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain(DEFERRED.key);
    expect(stale[0]).toContain("3 time(s), but that surface names it 0 time(s)");
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
  // reads identically to a clean one.
  //
  // Until W3 the known positives WERE the live exempted surfaces, and their
  // count was asserted from the corpus rather than from the list that exempted
  // them. The repricing removed the last of them, so the live corpus now scans
  // to zero — and "zero" is exactly what a scan that has gone inert also
  // reports. The floor therefore moves onto a synthetic positive, and the live
  // corpus is asserted CLEAN rather than merely quiet.
  it("still finds an offence when one is put in front of it, and finds none live", () => {
    const planted = retiredPlanNameHits(
      [DEFERRED, ...CORPUS],
      LIVE_PLAN_NAMES,
      RETIRED_PLAN_NAMES,
    );
    expect(
      planted.filter((h) => h.key === DEFERRED.key).length,
      "the scan did not see three plain 'Pro Plus' occurrences — it is inert",
    ).toBe(3);
    expect(new Set(planted.map((h) => h.name))).toEqual(new Set(["Pro Plus"]));

    // The live half. Zero offences and zero exemptions is the CLEAN state, and
    // the assertion above is what tells it apart from a broken scan.
    expect(retiredPlanNameHits(CORPUS, LIVE_PLAN_NAMES, RETIRED_PLAN_NAMES)).toEqual([]);
    expect(EXEMPT).toEqual([]);
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
