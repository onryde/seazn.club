// Help-copy leak guard. User-facing help must not carry the team's internal
// vocabulary: PR numbers, wave/task ids, spec marks, owner rulings, migration
// numbers, or developer words. findLeaks() (lib/copy-leaks.ts) is the pure
// detector; the sweep below runs it over EVERY Markdown help article and over
// the rendered text of EVERY generated /help/formats page.
//
// KNOWN is the cleanup backlog, keyed by section. Each content section's PR
// deletes its own entries as it cleans them. The sweep fails when
//   (a) a page leaks and is NOT in KNOWN (a new leak), or
//   (b) a KNOWN page leaks a rule that is not listed, or lists a rule it no
//       longer trips (a stale excuse that would hide the next regression).
// What is scanned: title, description and the body as helpPlainText gives it (inline code
// included, as readers see it), PLUS fenced code blocks on every page outside
// content/help/api (readers see those too; the API reference is the developer page).
// NOT yet scanned: image alt text and captions. They are added here when help pages
// carry pictures (the pictures task), so a leak in a caption cannot ship past this sweep.
// Anti-vacuity: both sources (Markdown, generated formats) must scan > 0 pages
// and every LEAK_ALLOW entry must have suppressed at least one real hit.
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { LEAK_ALLOW, LEAK_RULES, findLeaks, scanCopy, type LeakRule } from "@/lib/copy-leaks";
import { allHelpArticles, helpPlainText } from "@/server/help-content";
import { FORMAT_FAMILIES } from "@/config/format-gallery";
import FormatGalleryPage from "@/app/help/formats/page";
import FormatExplainerPage from "@/app/help/formats/[family]/page";

// ---------------------------------------------------------------------------
// Unit cases. Strings are hand-written from each rule's MEANING (not copied
// from help pages). Every rule has at least one positive and one negative.
// ---------------------------------------------------------------------------
const CASES: Record<LeakRule, { hit: string[]; clean: string[] }> = {
  "pr-number": {
    hit: ["Shipped in PR #123 last week.", "see PR 4567 for details", "Merged pull request #88."],
    clean: ["Press the button to continue.", "Our PR team answers emails.", "Open #1234 on the board is a heading, not a PR."],
  },
  "wave-id": {
    hit: ["This is the R6 behaviour.", "added in W2e", "tracked as RS011", "see PROMPT-30", "see PROMPT 30", "ticket B07b", "task T10b"],
    clean: ["Round 6 starts at nine.", "Wave goodbye to the crowd.", "Pitch B is free.", "A rating of 1500."],
  },
  "spec-mark": {
    hit: ["See §3.5 of the design.", "as in spec 2026-10-27", "per spec 2026 10 27"],
    clean: ["The spec sheet lists the court size.", "Section 3 explains seeding.", "Dates are shown as 27 October 2026."],
  },
  "internal-ruling": {
    hit: [
      "Per the owner ruling the draw is closed.",
      "This was owner-approved last month.",
      "Decided by the owner, 2026-10-27.",
      "decided 2026-10-27 and final",
      "decided 2026 10 27 and final",
      "A ruling on 2026-09-28 changed this.",
    ],
    clean: [
      "The owner can invite new staff.",
      "Ask the competition owner to approve the entry.",
      "Your registration opened on 2026-10-27.",
      "The referee's ruling stands.",
    ],
  },
  "migration-number": {
    hit: ["Added by V519.", "the V101 migration"],
    clean: ["Roman numeral V is five.", "Version 2 of the form.", "Court V4 is free"],
  },
  "developer-word": {
    hit: [
      "The engine builds the draw.",
      "A reducer folds the events.",
      "The payload carries the score.",
      "stored as jsonb",
      "POST to the webhook",
      "A cron job runs nightly.",
      "Two engines compete.",
      "Both reducers agree.",
      "Large payloads are rejected.",
      "Nightly crons run.",
      "Call the endpoint with your key.",
      "An entitlement unlocks the format.",
      "WEBHOOKS are signed.",
    ],
    clean: [
      "Search for the match in the list.",
      "Entitled to a refund.",
      "Engineer your own bracket.",
    ],
  },
};

/** The API reference is written for developers: webhook / endpoint are its subject there. */
const isDeveloperPage = (section: string): boolean => section === "api";

/** Fenced code block bodies (helpPlainText drops them, but readers see them). */
function fencedCode(markdown: string): string[] {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

/** The text the sweep scans for one article: what a reader sees, code blocks included outside the API section. */
function readerText(a: { title: string; description: string; markdown: string; section: string }): string {
  return [
    a.title,
    a.description,
    helpPlainText(a.markdown),
    ...(isDeveloperPage(a.section) ? [] : fencedCode(a.markdown)),
  ].join(" . ");
}

describe("findLeaks: one positive and one negative per rule", () => {
  for (const rule of LEAK_RULES) {
    it(`${rule}: flags every hit case and none of the clean cases`, () => {
      const { hit, clean } = CASES[rule];
      expect(hit.length, "anti-vacuity: positive cases exist").toBeGreaterThan(0);
      expect(clean.length, "anti-vacuity: negative cases exist").toBeGreaterThan(0);
      for (const text of hit) {
        const rules = findLeaks(text).map((l) => l.rule);
        expect(rules, `expected '${rule}' in: ${text}`).toContain(rule);
      }
      for (const text of clean) {
        const rules = findLeaks(text).map((l) => l.rule);
        expect(rules, `unexpected '${rule}' in: ${text}`).not.toContain(rule);
      }
    });
  }

  it("CASES covers exactly the declared rules (a new rule owes cases)", () => {
    expect(Object.keys(CASES).sort()).toEqual([...LEAK_RULES].sort());
  });

  it("reports the matched text and its index", () => {
    const text = "Shipped in PR #123 last week.";
    const [leak] = findLeaks(text);
    expect(leak).toBeDefined();
    expect(text.slice(leak!.index, leak!.index + leak!.match.length)).toBe(leak!.match);
  });

  it("empty and clean text report nothing", () => {
    expect(findLeaks("")).toEqual([]);
    expect(findLeaks("Create a competition, add entrants and share the link.")).toEqual([]);
  });

  it("webhook / endpoint are developer vocabulary everywhere except a developer page", () => {
    const text = "Register a webhook and call the endpoint.";
    expect(findLeaks(text).map((l) => l.rule)).toContain("developer-word");
    expect(findLeaks(text, { developerPage: true })).toEqual([]);
    // The exemption is only for those two words — engine stays a leak.
    expect(findLeaks("The engine posts a webhook.", { developerPage: true }).map((l) => l.match)).toEqual(["engine"]);
  });

  it("the API section is the developer page: webhook / endpoint pass there, and only there (real article paths)", () => {
    const articles = allHelpArticles();
    const api = articles.get("api/keys");
    const other = articles.get("billing/plans");
    expect(api, "premise: api/keys exists").toBeDefined();
    expect(other, "premise: a non-api article exists").toBeDefined();
    const text = "Register a webhook and call the endpoint.";
    const asApi = readerText({ ...api!, markdown: text });
    const asOther = readerText({ ...other!, markdown: text });
    expect(findLeaks(asApi, { developerPage: isDeveloperPage(api!.section) })).toEqual([]);
    expect(findLeaks(asOther, { developerPage: isDeveloperPage(other!.section) }).map((l) => l.match)).toEqual([
      "webhook",
      "endpoint",
    ]);
  });

  it("fenced code is scanned outside the API section, and still not inside it", () => {
    const md = "Intro.\n\n```json\n{ \"engine\": 1 }\n```\n";
    const base = { title: "A title here", description: "A description here", markdown: md };
    expect(helpPlainText(md), "premise: the plain-text pass drops the block").not.toContain("engine");
    expect(findLeaks(readerText({ ...base, section: "billing" })).map((l) => l.match)).toEqual(["engine"]);
    expect(findLeaks(readerText({ ...base, section: "api" }), { developerPage: true }).map((l) => l.match)).toEqual([]);
    // Inline code is already in the plain text.
    expect(findLeaks(readerText({ ...base, markdown: "Use `engine` here.", section: "billing" })).map((l) => l.match)).toEqual([
      "engine",
    ]);
  });

  it("'search engines' is ordinary English; a bare 'engines' (or the engine) still leaks", () => {
    expect(findLeaks("It is findable by search engines.")).toEqual([]);
    expect(findLeaks("The engines build it.").map((l) => l.match)).toEqual(["engines"]);
    expect(findLeaks("search engine internals").map((l) => l.match)).toEqual(["engine"]);
  });

  it("T20 (the cricket format) is allowed; other task ids are not", () => {
    expect(findLeaks("A T20 match has 20 overs.")).toEqual([]);
    expect(findLeaks("task T14 added it").map((l) => l.rule)).toEqual(["wave-id"]);
  });

  it("a listed match code is allowed only as the exact phrase", () => {
    expect(findLeaks("Winner of R1·3 plays on.")).toEqual([]);
    // Not listed: another round's code is still a wave-id leak.
    expect(findLeaks("Winner of R5·1 plays on.").map((l) => l.match)).toEqual(["R5"]);
    // A longer token that merely starts with a listed phrase is not excused.
    expect(findLeaks("Winner of R1·10 plays on.").map((l) => l.match)).toEqual(["R1"]);
    expect(findLeaks("See XR1·1 here.")).toEqual([]);
  });

  it("every LEAK_ALLOW entry has a phrase and a reason", () => {
    expect(LEAK_ALLOW.length, "anti-vacuity: the allow-list has entries").toBeGreaterThan(0);
    for (const a of LEAK_ALLOW) {
      expect(a.match.length, "phrase").toBeGreaterThan(0);
      expect(a.reason.length, `reason for '${a.match}'`).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

/** Generated pages sit under one pseudo-section so KNOWN stays keyed by section. */
const FORMATS_PAGES = "formats-pages";

type Known = Record<string, Record<string, LeakRule[]>>;
/** section -> page -> the rules that page is excused for. Sections delete their own entries. */
const KNOWN: Known = {
  divisions: { "divisions/groups-to-knockout": ["developer-word"] },
  "getting-started": { "getting-started/generate-fixtures": ["developer-word"] },
  registration: { "registration/card-payments": ["spec-mark"] },
  scheduling: {
    "scheduling/ai-officials": ["developer-word"],
    "scheduling/ai-scheduling": ["developer-word"],
  },
  scoring: {
    "scoring/batch-import": ["developer-word"],
    "scoring/knockout-deciders": ["developer-word"],
  },
  // Generated pages: the gallery overview and one page per family. Every one
  // says "the engine" (page copy and the live-example caption).
  [FORMATS_PAGES]: Object.fromEntries(
    [
      "formats",
      ...[
        "league", "groups-knockout", "knockout", "double_elim", "swiss", "stepladder",
        "page_playoff", "swiss_playoff", "swiss_knockout", "americano", "ladder",
      ].map((f) => `formats/${f}`),
    ].map((page) => [page, ["developer-word"] as LeakRule[]]),
  ),
};

/** Strip tags from rendered markup; decode the few entities React emits. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface PageScan {
  section: string;
  page: string;
  rules: Set<LeakRule>;
  hits: { rule: LeakRule; match: string }[];
}

describe("help copy carries no internal references", () => {
  it("sweeps every Markdown article and every generated /help/formats page", async () => {
    const scans: PageScan[] = [];
    const allowedUsed = new Map<string, number>();
    const record = (section: string, page: string, text: string, developerPage: boolean) => {
      const { leaks, allowed } = scanCopy(text, { developerPage });
      for (const a of allowed) allowedUsed.set(a.phrase, (allowedUsed.get(a.phrase) ?? 0) + 1);
      scans.push({
        section,
        page,
        rules: new Set(leaks.map((l) => l.rule)),
        hits: leaks.map((l) => ({ rule: l.rule, match: l.match })),
      });
    };

    // Source 1: Markdown articles (title + description + body, as the reader sees them).
    const articles = allHelpArticles();
    let markdownScanned = 0;
    for (const a of articles.values()) {
      record(a.section, a.slug, readerText(a), isDeveloperPage(a.section));
      markdownScanned += 1;
    }

    // Source 2: generated format pages, rendered through the REAL page components.
    let formatsScanned = 0;
    const overview = htmlToText(renderToStaticMarkup(FormatGalleryPage() as ReactElement));
    for (const f of FORMAT_FAMILIES) {
      expect(overview, `overview lists ${f.slug}`).toContain(f.title);
    }
    record(FORMATS_PAGES, "formats", overview, false);
    formatsScanned += 1;
    for (const f of FORMAT_FAMILIES) {
      const el = (await FormatExplainerPage({ params: Promise.resolve({ family: f.slug }) })) as ReactElement;
      const text = htmlToText(renderToStaticMarkup(el));
      // Positive pair: the page really rendered this family's registry copy.
      expect(text, `${f.slug}: title rendered`).toContain(f.title);
      expect(text, `${f.slug}: tagline rendered`).toContain(f.tagline);
      expect(text, `${f.slug}: live example rendered`).toContain("What you get with 8 entrants");
      record(FORMATS_PAGES, `formats/${f.slug}`, text, false);
      formatsScanned += 1;
    }

    const leaking = scans.filter((s) => s.rules.size > 0);
    const knownPages = Object.values(KNOWN).reduce((n, s) => n + Object.keys(s).length, 0);
    console.log(
      `help-no-internal-references: markdown pages scanned=${markdownScanned}, ` +
        `generated formats pages scanned=${formatsScanned}, leaking pages=${leaking.length}, KNOWN pages=${knownPages}, ` +
        `allow-list uses=${JSON.stringify(Object.fromEntries(allowedUsed))}`,
    );

    // Anti-vacuity: neither source may scan zero; the generated count comes from the registry.
    expect(markdownScanned, "anti-vacuity: markdown articles scanned").toBeGreaterThan(0);
    expect(markdownScanned, "every article scanned").toBe(articles.size);
    expect(formatsScanned, "anti-vacuity: generated formats pages scanned").toBeGreaterThan(0);
    expect(formatsScanned, "overview + one per family").toBe(FORMAT_FAMILIES.length + 1);
    for (const a of LEAK_ALLOW) {
      expect(allowedUsed.get(a.match) ?? 0, `stale allow-list entry '${a.match}' suppressed nothing`).toBeGreaterThan(0);
    }

    const problems: string[] = [];
    for (const s of scans) {
      const listed = KNOWN[s.section]?.[s.page];
      const sample = (rule: LeakRule) =>
        s.hits
          .filter((h) => h.rule === rule)
          .map((h) => `'${h.match}'`)
          .slice(0, 4)
          .join(", ");
      if (!listed) {
        for (const rule of s.rules) problems.push(`NEW LEAK  ${s.section} :: ${s.page} :: ${rule}: ${sample(rule)}`);
        continue;
      }
      for (const rule of s.rules) {
        if (!listed.includes(rule)) problems.push(`UNLISTED RULE on KNOWN page  ${s.page} :: ${rule}: ${sample(rule)}`);
      }
      for (const rule of listed) {
        if (!s.rules.has(rule)) problems.push(`STALE EXCUSE  ${s.page} no longer trips '${rule}' (remove it from KNOWN)`);
      }
    }
    // A KNOWN entry naming a page that does not exist is also a stale excuse.
    const scannedKeys = new Set(scans.map((s) => `${s.section}::${s.page}`));
    for (const [section, pages] of Object.entries(KNOWN)) {
      for (const page of Object.keys(pages)) {
        if (!scannedKeys.has(`${section}::${page}`)) problems.push(`STALE EXCUSE  ${section} :: ${page} is not a scanned page`);
      }
    }
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });
});
