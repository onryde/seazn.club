import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StageRail } from "../stage-rail";

const stage = { id: "s1", name: "League", kind: "league", seq: 1, status: "active" } as never;

// Task 4 — every existing call site grows the three new required props.
// `unscheduledBadgeSlot: null` / `capacityBlocked: null` / a no-op
// `onAutoSchedule` are neutral defaults: a null slot means the pinned
// unscheduled section (and its CTA) stays absent, so these pre-existing
// tests keep asserting exactly what they asserted before this task touched
// the file. Fix round 2 (Ruling T4-B): the rail no longer builds the badge
// itself from a count — it renders whatever `unscheduledBadgeSlot` element
// the panel hands it, same `courtTagsSlot` shape, so the panel can also
// mount that SAME element inline for a non-editing viewer.
const NEUTRAL = { unscheduledBadgeSlot: null, capacityBlocked: null, onAutoSchedule: () => {} };
const BADGE = <p data-testid="stage-unscheduled-count">3</p>;

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

  it("renders nothing at all when the viewer cannot edit — even with a non-null badge slot", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit={false} busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL} unscheduledBadgeSlot={BADGE} />,
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
        unscheduledBadgeSlot={BADGE}
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
        unscheduledBadgeSlot={BADGE}
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

  it("renders no pinned section at all — no badge, no CTA, no blocked reason — when unscheduledBadgeSlot is null", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null} {...NEUTRAL}
        capacityBlocked={{ blocked: true, reason: "unreachable — no section to hang it on" }} />,
    );
    expect(html).not.toContain('data-testid="stage-unscheduled-count"');
    expect(html).not.toContain('data-testid="stage-auto-schedule"');
    expect(html).not.toContain('data-testid="stage-auto-schedule-blocked"');
  });

  it("renders whatever unscheduledBadgeSlot element it is given, verbatim — the rail builds no badge markup of its own", () => {
    const html = renderToStaticMarkup(
      <StageRail stage={stage} canEdit busy={null} fixtureCount={4} deletable
        onAct={() => {}} onDelete={() => {}} addingTo={null} onToggleAddMatch={() => {}}
        adhoc={false} courtTagsSlot={null}
        unscheduledBadgeSlot={<p data-testid="stage-unscheduled-count" data-marker="from-panel">7</p>}
        capacityBlocked={null}
        onAutoSchedule={() => {}} />,
    );
    expect(html).toContain('data-marker="from-panel"');
    const match = /data-testid="stage-unscheduled-count"[^>]*>(\d+)</.exec(html);
    expect(match?.[1]).toBe("7");
  });
});
