// Plan figures in help come from the plan table (`{{plan:<feature>:<plan>}}`,
// server/help-tokens.ts), never typed. This sweep fails when a help article
// types a percentage or a currency amount on a line that also names a plan
// (Community, Event Pass, Pro) or "platform fee": that figure goes stale on the
// next pricing change.
//
// KNOWN is the conversion backlog: page -> why it still types figures. The
// billing / registration content tasks delete their own entries as they convert.
// The sweep fails when
//   (a) a page types a plan figure and is NOT in KNOWN (a new typed figure), or
//   (b) a KNOWN page no longer has a typed figure (a stale excuse that would
//       hide the next regression), or names a page that does not exist.
// Anti-vacuity: articles are scanned (> 0), the detector's own cases hit and
// clean, and the KNOWN backlog must be hit by at least one real line.
//
// Scope, on purpose: a figure on a line that names no plan ("3 AI credits a
// month", "up to 10 divisions") is not caught here; this guards the plan-price
// and platform-fee figures a pricing change moves.
import { describe, expect, it } from "vitest";
import { allHelpArticles } from "@/server/help-content";

const FIGURE = /\d+(?:\.\d+)?\s?%|[$£€]\s?\d/;
const PLAN_WORD = /\b(?:Community|Event Pass|Pro)\b|platform fee/i;

/** Lines that type a plan figure: a % or a currency amount beside a plan name or "platform fee". */
function typedPlanFigureLines(markdown: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  markdown.split("\n").forEach((text, i) => {
    if (FIGURE.test(text) && PLAN_WORD.test(text)) out.push({ line: i + 1, text: text.trim() });
  });
  return out;
}

describe("typedPlanFigureLines: hand-written cases", () => {
  const HIT = [
    "| Community | 5% |",
    "Event Pass — $11.99 one-time",
    "a 3% platform fee on entry fees",
    "The Platform Fee is 2.5% here.",
    "Pro is £14.99 a month.",
    "That costs €12 on Event Pass.",
    "Community pays 5% and {{plan:registration.fee_percent:pro}}% on Pro.", // a token beside a typed figure still hits
  ];
  const CLEAN = [
    "| Community | {{plan:registration.fee_percent:community}} |",
    "Fee: {{plan:registration.fee_percent:pro}}%",
    "Add your 64 entrants and share the link.",
    "A 5% swing in the vote.", // a figure, but no plan named
    "The Pro Series trophy.", // "Pro" alone, no figure
    "Provider fees are 3%.", // 'Pro' only as a prefix of another word
    "Community days are free.",
    "",
  ];
  it("flags every hit case and none of the clean cases", () => {
    expect(HIT.length, "anti-vacuity: positive cases exist").toBeGreaterThan(0);
    expect(CLEAN.length, "anti-vacuity: negative cases exist").toBeGreaterThan(0);
    for (const text of HIT) expect(typedPlanFigureLines(text), `should flag: ${text}`).toHaveLength(1);
    for (const text of CLEAN) expect(typedPlanFigureLines(text), `should not flag: ${text}`).toEqual([]);
  });
  it("reports the 1-based line number", () => {
    expect(typedPlanFigureLines("ok\n\n| Pro | 2% |")).toEqual([{ line: 3, text: "| Pro | 2% |" }]);
  });
});

/** page -> why it still types a plan figure. Read every hit line before adding or removing one. */
const FEE = "fee percent per plan: a billing/registration content task converts it to {{plan:registration.fee_percent:<plan>}}";
const PRICE = "plan price: not token-able yet (this task renders int_value features only, no prices)";
const KNOWN: Record<string, string> = {
  "billing/downgrade": `${FEE} (5/2/1 and the Event Pass 3% lock-in)`,
  "billing/event-pass": `${PRICE} ($11.99, twice) + ${FEE} + an illustrative $2,000 / $40 example`,
  "billing/groups": `${PRICE} ($14.99, $6.99, $128.99, $63.99, $384.95, $644.95) + ${FEE} + an illustrative 60%-off coupon`,
  "billing/plans": `${PRICE} ($11.99, $14.99, $6.99) + ${FEE} (the fee ladder table and four inline fees)`,
  "getting-started/create-your-organisation": FEE,
  "registration/card-payments": `${FEE} (the fee ladder table)`,
  "registration/open-registration": FEE,
  "sharing/sponsors": "flat 5% sponsorship fee, the same on every plan (not a per-plan figure); the billing task decides whether it becomes a token",
};

describe("help articles type no plan figures", () => {
  it("sweeps every Markdown article; only KNOWN pages type a plan figure, and each still does", () => {
    const articles = allHelpArticles();
    const hitsByPage = new Map<string, { line: number; text: string }[]>();
    for (const a of articles.values()) {
      const hits = typedPlanFigureLines(a.markdown);
      if (hits.length > 0) hitsByPage.set(a.slug, hits);
    }
    const totalLines = [...hitsByPage.values()].reduce((n, h) => n + h.length, 0);
    console.log(
      `help-no-typed-plan-figures: articles scanned=${articles.size}, pages with typed figures=${hitsByPage.size}, ` +
        `lines=${totalLines}, KNOWN pages=${Object.keys(KNOWN).length}`,
    );

    expect(articles.size, "anti-vacuity: articles scanned").toBeGreaterThan(0);
    expect(hitsByPage.size, "anti-vacuity: the KNOWN backlog is hit by real lines").toBeGreaterThan(0);

    const problems: string[] = [];
    for (const [page, hits] of hitsByPage) {
      if (!(page in KNOWN)) {
        problems.push(`NEW TYPED FIGURE  ${page}: ${hits.slice(0, 3).map((h) => `L${h.line} '${h.text.slice(0, 70)}'`).join("; ")}`);
      }
    }
    for (const page of Object.keys(KNOWN)) {
      if (!articles.has(page)) problems.push(`STALE EXCUSE  ${page} is not a help article`);
      else if (!hitsByPage.has(page)) problems.push(`STALE EXCUSE  ${page} no longer types a plan figure (remove it from KNOWN)`);
      expect(KNOWN[page]!.length, `reason for ${page}`).toBeGreaterThan(10);
    }
    expect(problems, `\n${problems.join("\n")}\n`).toEqual([]);
  });
});
