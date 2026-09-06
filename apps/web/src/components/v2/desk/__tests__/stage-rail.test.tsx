import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StageRail } from "../stage-rail";

const stage = { id: "s1", name: "League", kind: "league", seq: 1, status: "active" } as never;

// Task 4 — every existing call site grows the three new required props.
// `unscheduledCount: 0` / `capacityBlocked: null` / a no-op `onAutoSchedule`
// are neutral defaults: 0 means the pinned unscheduled section (and its CTA)
// stays absent, so these four pre-existing tests keep asserting exactly what
// they asserted before this task touched the file.
const NEUTRAL = { unscheduledCount: 0, capacityBlocked: null, onAutoSchedule: () => {} };

describe("StageRail", () => {
  it("renders the three header controls with their testids", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(html).toContain('data-testid="stage-generate"');
    expect(html).toContain('data-testid="stage-complete"');
    expect(html).toContain('data-testid="stage-delete"');
  });

  it("renders nothing at all when the viewer cannot edit", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit={false} busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} unscheduledCount={7} />,
    );
    expect(html).toBe("");
  });

  it("renders the Add match control for an ad-hoc stage kind, and omits it for a kind not in ADHOC_STAGE_KINDS", () => {
    const adhocHtml = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(adhocHtml).toContain('data-testid="stage-add-match"');

    const nonAdhocHtml = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(nonAdhocHtml).not.toContain('data-testid="stage-add-match"');
  });

  it("renders courtTagsSlot content where given", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={<i data-testid="ct-slot" />} {...NEUTRAL} />,
    );
    expect(html).toContain('data-testid="ct-slot"');
  });

  // Task 4 — the auto-schedule CTA's blocked reason. Assert the REASON
  // STRING is present in one state and ABSENT in the other (not merely that
  // the button exists), or the test witnesses nothing (brief's own warning —
  // a button-only probe passes in both states).
  it("renders the blocked reason when capacityBlocked.blocked is true", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null}
        unscheduledCount={3}
        capacityBlocked={{ blocked: true, reason: "No courts on Saturday" }}
        onAutoSchedule={() => {}} />,
    );
    expect(html).toContain('data-testid="stage-auto-schedule"');
    expect(html).toContain('data-testid="stage-auto-schedule-blocked"');
    expect(html).toContain("No courts on Saturday");
    const ctaOpenTag = html.slice(
      html.indexOf('data-testid="stage-auto-schedule"') - 200,
      html.indexOf('data-testid="stage-auto-schedule"') + 200,
    );
    expect(ctaOpenTag).toContain("disabled");
  });

  it("renders enabled with no reason text when capacityBlocked.blocked is false", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null}
        unscheduledCount={3}
        capacityBlocked={{ blocked: false, reason: null }}
        onAutoSchedule={() => {}} />,
    );
    expect(html).toContain('data-testid="stage-auto-schedule"');
    expect(html).not.toContain('data-testid="stage-auto-schedule-blocked"');
    expect(html).not.toContain("No courts on Saturday");
    const ctaOpenTag = html.slice(
      html.indexOf('data-testid="stage-auto-schedule"') - 200,
      html.indexOf('data-testid="stage-auto-schedule"') + 200,
    );
    expect(ctaOpenTag).not.toContain("disabled");
  });

  it("renders the unscheduled count and omits the CTA entirely when unscheduledCount is 0", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} />,
    );
    expect(html).not.toContain('data-testid="stage-unscheduled-count"');
    expect(html).not.toContain('data-testid="stage-auto-schedule"');
  });

  it("renders the unscheduled count badge with the given count", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null}
        unscheduledCount={5}
        capacityBlocked={null}
        onAutoSchedule={() => {}} />,
    );
    const match = /data-testid="stage-unscheduled-count"[^>]*>(\d+)</.exec(html);
    expect(match?.[1]).toBe("5");
  });
});
