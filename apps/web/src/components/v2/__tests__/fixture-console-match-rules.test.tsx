// W2c Task 19 (S2) - the console MOUNTS the match rules block, for the organiser who is handed it and nobody else, inside
// one phone disclosure (one DOM: folded below md, a plain card from md up). The inert-seam test: the block is reached
// through the real console, not only through its own component test.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FixtureConsole, type SideInfo } from "@/components/v2/fixture-console";
import { matchRulesBlockProps } from "@/components/v2/match-rules-block-model";
import { moduleFor } from "@/lib/rule-scope";
import enUi from "@/dictionaries/en/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const EN = enUi as Record<string, string>;
const side = (id: string, name: string): SideInfo => ({ id, name, kind: "team", members: [], lineup: [] });
const badminton = moduleFor("badminton")!;
const stage = badminton.configSchema.parse(badminton.variants.short) as Record<string, unknown>;

function consoleHtml(withBlock: boolean, override: Record<string, unknown> | null = null): string {
  return renderToStaticMarkup(
    <FixtureConsole
      fixture={{ id: "f1", status: "scheduled", scheduled_at: null, venue_name: null, court_name: null, round_no: 1 }}
      sport={{ key: "badminton", config: {}, scorerLabel: "Umpire", positionGroups: [], roles: [], lineupSize: 0, benchMax: 0 }}
      home={side("e1", "Home")}
      away={side("e2", "Away")}
      initialState={{ status: "scheduled", last_seq: 0, summary: null, state: {}, outcome: null }}
      initialEvents={[]}
      canEdit
      canOrganise
      stageKind="league"
      viewerPlan="community"
      matchRules={
        withBlock
          ? matchRulesBlockProps("f1", {
              sportKey: "badminton",
              stageKind: "league",
              variant: "short",
              stageLine: "Best of 3",
              stageResolved: stage,
              effective: override === null ? stage : { ...stage, ...override },
              override,
              state: "unstarted",
            })
          : undefined
      }
    />,
  );
}
const toggles = (html: string): string[] => [...html.matchAll(/<button[^>]*data-role="phone-disclosure-toggle"[^>]*>.*?<\/button>/gs)].map((m) => m[0]);

describe("the console mounts the match rules block", () => {
  it("handed matchRules: the block is on the page, inside a phone disclosure that is folded below md (not at md and up)", () => {
    const html = consoleHtml(true);
    expect(html).toContain('data-testid="match-rules-block"');
    const toggle = toggles(html).find((t) => t.includes(EN["matchRules.title"]!));
    expect(toggle, "a disclosure toggle titled 'Match rules'").toBeDefined();
    expect(toggle).toContain(`aria-label="${EN["matchRules.show"]}"`);
    expect(toggle, "phone-only: the toggle hides from md up").toMatch(/\smd:hidden/);
    // The block sits in that disclosure's body, which is folded on a phone and a plain card from md.
    const at = html.indexOf('data-testid="match-rules-block"');
    const bodyOpen = html.lastIndexOf('<div class="grid flex-1 max-md:hidden"', at);
    expect(bodyOpen, "the block's disclosure body is max-md:hidden").toBeGreaterThan(-1);
  });

  it("not handed matchRules (a scorer, a viewer, a frozen competition): no block and no extra disclosure", () => {
    const withBlock = consoleHtml(true);
    const without = consoleHtml(false);
    expect(without).not.toContain("match-rules-block");
    expect(toggles(withBlock).length - toggles(without).length, "exactly one disclosure more").toBe(1);
  });

  it("an override in force shows on the closed phone row too, so the phone organiser sees it without opening", () => {
    const toggle = toggles(consoleHtml(true, { bestOf: 1 })).find((t) => t.includes(EN["matchRules.title"]!))!;
    expect(toggle).toContain(EN["matchRules.overridden"]);
    const quiet = toggles(consoleHtml(true)).find((t) => t.includes(EN["matchRules.title"]!))!;
    expect(quiet).not.toContain(EN["matchRules.overridden"]);
  });
});
