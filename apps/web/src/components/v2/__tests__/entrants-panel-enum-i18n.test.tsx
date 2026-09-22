// The two ENUM COLUMNS of the entrants table, in all four locales.
//
// Round 3 translated the table's headers and left the values under them raw,
// and said so: a Spanish console read `Estado` over a column of English
// `withdrawn`. The owner ruled that shape unshippable (#836) — by the same
// reasoning that made "Withdraw | Eliminar" on one row worse than a uniformly
// English one — so the values come with their headers.
//
// THE VALUE SET IS DERIVED FROM THE SCHEMA, not typed into this file. The
// CHECK constraints in `V212__entrants.sql` are the only source of truth for
// what those columns may hold, so a fifth status added there reds this suite
// instead of silently printing an untranslated word at a customer.
//
// Rendered, not key-checked: a dictionary entry nothing reads is the inert
// seam (AGENTS.md 1). Every assertion below folds the real catalogue through
// the real component and reads the cell a customer would see.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { DictProvider } from "@/components/i18n/dict-provider";
import { EntrantsPanel, type EntrantsPanelEligibility } from "@/components/v2/entrants-panel";
import { LOCALES, type Dict, type Locale } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));
vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return { ...actual, apiV1: vi.fn(async () => ({ items: [], nextCursor: null })) };
});

const DICTS: Record<Locale, Dict> = { en, fr, es, nl };

// --- the schema, read rather than restated ---------------------------------

const SCHEMA = fileURLToPath(
  new URL("../../../../../../db/migration/v2-engine/tables/V212__entrants.sql", import.meta.url),
);

/** The values a column may hold, straight out of its own CHECK constraint.
 *  `check (status in ('registered','confirmed', …))`. */
function schemaValues(column: string): string[] {
  const sql = readFileSync(SCHEMA, "utf8");
  const m = new RegExp(`check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`, "i").exec(sql);
  expect(m, `no CHECK constraint for ${column} in V212__entrants.sql`).not.toBeNull();
  const values = [...m![1]!.matchAll(/'([^']+)'/g)].map((q) => q[1]!);
  // A regex that matched but captured nothing would make every loop below
  // vacuous — the empty set passes any "for each" assertion.
  expect(values.length, `${column}'s CHECK constraint parsed to no values`).toBeGreaterThan(1);
  return values;
}

const KINDS = schemaValues("kind");
const STATUSES = schemaValues("status");

/** The catalogue key each value renders through. The KIND half deliberately
 *  reuses `divset.entrants.kind.*`, which this component ALREADY reads for the
 *  add-form's kind chips — one word per kind across the console. */
const KIND_KEY = (kind: string): string => `divset.entrants.kind.${kind}`;
const STATUS_KEY = (status: string): string => `entrants.status.${status}`;

// --- the panel -------------------------------------------------------------

const NO_ELIGIBILITY: EntrantsPanelEligibility = {
  category: null,
  age_min: null,
  age_max: null,
  eligibility_note: null,
};

const MODEL: EffectiveEntrantModel = {
  kinds: ["individual", "pair", "team"],
  defaultKind: "individual",
  squadNumbers: true,
  captain: true,
  maxTeamMembers: null,
};

interface Row {
  id: string;
  kind: string;
  team_id: string | null;
  display_name: string;
  seed: number | null;
  status: string;
  badge_url: string | null;
}

function row(over: Partial<Row>): Row {
  return {
    id: "e1",
    kind: "individual",
    team_id: null,
    display_name: "Ada Lovelace",
    seed: null,
    status: "registered",
    badge_url: null,
    ...over,
  };
}

function panelHtml(locale: Locale, entrants: Row[]): string {
  return renderToStaticMarkup(
    <DictProvider dict={DICTS[locale]} locale={locale}>
      <EntrantsPanel
        divisionId="div-1"
        entrants={entrants}
        canEdit
        positionGroups={[]}
        roles={[]}
        eligibility={NO_ELIGIBILITY}
        entrantModel={MODEL}
        viewerPlan="community"
        divisionStatus="setup"
      />
    </DictProvider>,
  );
}

function decode(s: string): string {
  return s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The cell carrying `data-<attr>="<value>"`: the RAW value the element still
 *  publishes, and the WORD a customer reads in it. Both halves matter — the
 *  raw value is what `withdrawn-entrant-organiser.spec.ts` and any style map
 *  key on, and it must survive the translation of the text beside it. */
function cell(html: string, attr: string, value: string): { text: string; className: string } {
  const m = new RegExp(
    `<(td|span)([^>]*\\sdata-${attr}="${value}"[^>]*)>([\\s\\S]*?)</\\1>`,
  ).exec(html);
  expect(m, `no element carrying data-${attr}="${value}"`).not.toBeNull();
  const cls = /class="([^"]*)"/.exec(m![2]!);
  return {
    text: decode(m![3]!.replace(/<[^>]*>/g, "").trim()),
    className: cls ? cls[1]! : "",
  };
}

const value = (dict: Dict, key: string): string => t(dict, key as never);

describe("the entrants table's enum columns speak the reader's language", () => {
  it("every kind and status the SCHEMA allows has a catalogue key in all four locales", () => {
    for (const kind of KINDS) {
      for (const locale of LOCALES) {
        const v = value(DICTS[locale], KIND_KEY(kind));
        expect(v, `${locale} has no label for kind "${kind}"`).not.toBe(KIND_KEY(kind));
        expect(v.trim().length, `${locale}'s label for kind "${kind}" is empty`).toBeGreaterThan(0);
      }
    }
    for (const status of STATUSES) {
      for (const locale of LOCALES) {
        const v = value(DICTS[locale], STATUS_KEY(status));
        expect(v, `${locale} has no label for status "${status}"`).not.toBe(STATUS_KEY(status));
        expect(v.trim().length, `${locale}'s label for status "${status}" is empty`).toBeGreaterThan(0);
      }
    }
  });

  it("the kind cell paints the console's own word for that kind, and keeps the raw value", () => {
    for (const locale of LOCALES) {
      const html = panelHtml(
        locale,
        KINDS.map((kind, i) => row({ id: `k${i}`, kind, display_name: `Entrant ${i}` })),
      );
      for (const kind of KINDS) {
        const c = cell(html, "entrant-kind", kind);
        expect(c.text, `${locale} prints "${c.text}" for kind "${kind}"`).toBe(
          value(DICTS[locale], KIND_KEY(kind)),
        );
      }
    }
  });

  it("the status cell paints the translated status, and keeps the raw value on the element", () => {
    for (const locale of LOCALES) {
      const html = panelHtml(
        locale,
        STATUSES.map((status, i) => row({ id: `s${i}`, status, display_name: `Entrant ${i}` })),
      );
      for (const status of STATUSES) {
        const c = cell(html, "entrant-status", status);
        expect(c.text, `${locale} prints "${c.text}" for status "${status}"`).toBe(
          value(DICTS[locale], STATUS_KEY(status)),
        );
      }
    }
  });

  // The catalogue read RAW, which is the only view in which a locale left on
  // the English word is visible: every assertion above derives its expectation
  // from the same catalogue the component reads, so mutating a locale moves
  // both sides together and the render loop stays green (round 3, three
  // survivors).
  it("no status is left on the English word in any catalogue", () => {
    for (const status of STATUSES) {
      const values = LOCALES.map((l) => value(DICTS[l], STATUS_KEY(status)));
      expect(
        new Set(values).size,
        `two locales share "${status}" (${values.join(" / ")}) — one was left in English`,
      ).toBe(LOCALES.length);
    }
  });

  // Two of the four names also exist on the REGISTRATION enum, which is a
  // different set (pending/paid/waitlisted/expired/rejected) and deliberately
  // keeps its own keys. Where the two domains do share a word, they share the
  // WORDING — otherwise one tab of the same console says Retirado and the next
  // one says something else for the identical English status. `registered` and
  // `disqualified` have no registration twin, so nothing pins those two beyond
  // the distinctness above; that hole is deliberate and stated rather than
  // papered over.
  it("the shared status words match the registrants table locale for locale", () => {
    for (const status of ["confirmed", "withdrawn"]) {
      for (const locale of LOCALES) {
        expect(
          value(DICTS[locale], STATUS_KEY(status)),
          `${locale}'s "${status}" drifted off the registrants table's word`,
        ).toBe(value(DICTS[locale], `reg.hub.registrants.status.${status}`));
      }
    }
  });

  // The decision, stated as a test: a value the schema gains later prints
  // ITSELF. `t()` answers a miss with the key PATH, so the do-nothing option
  // would put "entrants.status.suspended" in front of a customer, and an empty
  // cell would hide a real state entirely.
  it("a value no catalogue knows prints the stored word, never a key path", () => {
    const html = panelHtml("fr", [row({ id: "x", kind: "quartet", status: "suspended" })]);
    expect(cell(html, "entrant-kind", "quartet").text).toBe("quartet");
    expect(cell(html, "entrant-status", "suspended").text).toBe("suspended");
    expect(html, "a key path reached the markup").not.toContain("entrants.status.suspended");
    expect(html, "a key path reached the markup").not.toContain("divset.entrants.kind.quartet");
  });

  // The raw value does more than print: it drives the row's own behaviour.
  // Translating the TEXT must not move the branch that reads the VALUE.
  it("a withdrawn entrant still dims its row, styles its badge and offers Reinstate", () => {
    const html = panelHtml("nl", [row({ id: "w", status: "withdrawn" })]);
    expect(html).toContain('data-testid="entrant-row-reinstate"');
    expect(html, "the withdrawn row lost its dimming").toContain("opacity-50");
    const registered = panelHtml("nl", [row({ id: "r", status: "registered" })]);
    expect(
      cell(html, "entrant-status", "withdrawn").className,
      "withdrawn and registered badges look identical — the style map stopped seeing the raw value",
    ).not.toBe(cell(registered, "entrant-status", "registered").className);
  });
});
