// W2c Task 19 (S2) - the console MOUNTS the match rules block, for the organiser who is handed it and nobody else, inside
// one phone disclosure (one DOM: folded below md, a plain card from md up). The inert-seam test: the block is reached
// through the real console, not only through its own component test.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FixtureConsole, type SideInfo } from "@/components/v2/fixture-console";
import { matchRulesBlockProps } from "@/components/v2/match-rules-block-model";
import { matchFieldsFor, moduleFor } from "@/lib/rule-scope";
import enUi from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const EN = enUi as Record<string, string>;
const side = (id: string, name: string): SideInfo => ({ id, name, kind: "team", members: [], lineup: [] });
const badminton = moduleFor("badminton")!;
const stage = badminton.configSchema.parse(badminton.variants.short) as Record<string, unknown>;

function consoleHtml(withBlock: boolean, override: Record<string, unknown> | null = null, opts: { line?: string; viewer?: boolean; panel?: "rules" } = {}): string {
  return renderToStaticMarkup(
    <FixtureConsole
      fixture={{ id: "f1", status: "scheduled", scheduled_at: null, venue_name: null, court_name: null, round_no: 1 }}
      sport={{ key: "badminton", config: {}, scorerLabel: "Umpire", positionGroups: [], roles: [], lineupSize: 0, benchMax: 0 }}
      home={side("e1", "Home")}
      away={side("e2", "Away")}
      initialState={{ status: "scheduled", last_seq: 0, summary: null, state: {}, outcome: null }}
      initialEvents={[]}
      canEdit={opts.viewer !== true}
      canOrganise={opts.viewer !== true}
      matchFormatLine={opts.line}
      stageKind="league"
      viewerPlan="community"
      initialPanel={opts.panel}
      matchRules={
        withBlock
          ? matchRulesBlockProps("f1", {
              sportKey: "badminton",
              stageKind: "league",
              variant: "short",
              stageLine: "Best of 3",
              stageResolved: stage,
              effective: override === null ? stage : { ...stage, ...override },
              effectiveLine: "Best of 3",
              override,
              state: "unstarted",
              cancelled: false,
              fields: matchFieldsFor({ module: badminton, stageKind: "league", variant: "short" }),
            })
          : undefined
      }
    />,
  );
}
/** The Match rules button of the header panel bar (owner 2026-11-11), whole. */
const ruleButton = (html: string): string | undefined => /<button[^>]*data-testid="match-rules-toggle"[^>]*>.*?<\/button>/s.exec(html)?.[0];
/** The Match rules panel's opening tag. */
const rulesPanelTag = (html: string): string | undefined => /<section[^>]*data-panel="rules"[^>]*>/.exec(html)?.[0];

describe("the console mounts the match rules block", () => {
  it("handed matchRules: the block is on the page, in the Match rules panel — hidden until its bar button opens it, at every width", () => {
    const html = consoleHtml(true);
    expect(html).toContain('data-testid="match-rules-block"');
    const button = ruleButton(html);
    expect(button, "a bar button titled 'Match rules'").toBeDefined();
    expect(button).toContain(EN["matchRules.title"]!);
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('aria-controls="console-panel-rules"');
    expect(rulesPanelTag(html), "closed: the panel is hidden (not just on a phone) but stays mounted for its draft").toMatch(/class="[^"]*\shidden"/);
    expect(html.indexOf('data-panel="rules"')).toBeLessThan(html.indexOf('data-testid="match-rules-block"'));
    const open = consoleHtml(true, null, { panel: "rules" });
    expect(rulesPanelTag(open), "open: no hiding class").not.toMatch(/\bhidden\b/);
    expect(ruleButton(open)).toContain('aria-expanded="true"');
  });

  it("not handed matchRules (a scorer, a viewer, a frozen competition) and no line: no block, no button, no panel", () => {
    const without = consoleHtml(false);
    expect(without).not.toContain("match-rules-block");
    expect(ruleButton(without)).toBeUndefined();
    expect(rulesPanelTag(without)).toBeUndefined();
    expect(ruleButton(consoleHtml(true)), "the positive pair: handed the block, it has its button").toBeDefined();
  });

  it("an override in force shows on the button itself, so the organiser sees it without opening the panel", () => {
    const button = ruleButton(consoleHtml(true, { bestOf: 1 }))!;
    expect(button).toContain(EN["matchRules.overridden"]);
    expect(ruleButton(consoleHtml(true))).not.toContain(EN["matchRules.overridden"]);
  });
});

// Match Day C2 fix round 1, I2: the read-only Match format card (`match-format-card`) the fixture page gives everyone it does not
// hand the organiser's block - the format the match plays, in the public line's words (`fixtureFormatLines`). The line is any
// string the page reads; this pins what the CONSOLE does with it.
describe("the console's read-only Match format card", () => {
  const LINE = "Best of 3 games to 21";
  /** The card's own markup: from its testid to the end of its section. */
  const cardOf = (html: string): string | undefined => {
    const at = html.indexOf('data-testid="match-format-card"');
    if (at < 0) return undefined;
    return html.slice(at, html.indexOf("</section>", at));
  };

  it("a viewer sees the line in the card, and nothing in it can be changed: no input, select, textarea or button", () => {
    const card = cardOf(consoleHtml(false, null, { line: LINE, viewer: true }));
    expect(card, "the card is on the page").toBeDefined();
    expect(card).toContain(LINE);
    expect(card, "its heading").toContain(EN["rulesStrip.format"]!);
    expect(card, "read-only").not.toMatch(/<(input|select|textarea|button)\b/);
  });

  it("the organiser handed the match rules block gets the block, never the card too (one format on the page)", () => {
    const html = consoleHtml(true, null, { line: LINE });
    expect(html).toContain('data-testid="match-rules-block"');
    expect(cardOf(html), "no card beside the block").toBeUndefined();
  });

  it("no line to say - an empty one, or none read - and there is no card at all (never an empty box)", () => {
    expect(cardOf(consoleHtml(false, null, { line: "", viewer: true })), "empty line").toBeUndefined();
    expect(cardOf(consoleHtml(false, null, { viewer: true })), "no line").toBeUndefined();
  });
});
