// apps/web/src/components/v2/scorepad/v3/__tests__/activity-collapsible.test.tsx
// Spec 2026-09-02-scorepad-v3-phone-composition-design.md §3.9. Rendered through
// react-dom/server — this workspace's vitest is `environment: "node"` (no DOM), so
// this pins WHICH nodes carry the phone class; whether the class takes EFFECT is
// proved by e2e/mobile.spec.ts `expectPhoneComposition` at seven widths.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityPanel, type ActivityEvent, type ActivityPanelProps } from "../activity";

function ev(over: Partial<ActivityEvent> & { id: string; seq: number }): ActivityEvent {
  return { type: "core.point", payload: {}, voids: null, ...over };
}
// Ascending on purpose: the component must pick the LATEST by seq, not index 0.
const THREE = [ev({ id: "a", seq: 1 }), ev({ id: "b", seq: 2 }), ev({ id: "c", seq: 3 })];
const t = ((key: string) => key) as unknown as ActivityPanelProps["t"];

function render(over: Partial<ActivityPanelProps>): string {
  return renderToStaticMarkup(
    <ActivityPanel
      events={THREE}
      ownEventIds={new Set()}
      deviceLinkId={null}
      personNames={{}}
      t={t}
      {...over}
    />,
  );
}
const liTags = (html: string) => html.match(/<li[^>]*data-role="v3-activity-row"[^>]*>/g) ?? [];
const eventId = (tag: string) => /data-event-id="([^"]+)"/.exec(tag)?.[1];

describe("ActivityPanel collapsible (phone)", () => {
  it("collapsed: only the latest-by-seq row is visible on phone; the rest carry max-md:hidden", () => {
    const tags = liTags(render({ collapsible: true }));
    expect(tags).toHaveLength(3);
    const visible = tags.filter((x) => !x.includes("max-md:hidden"));
    expect(visible).toHaveLength(1);
    expect(eventId(visible[0])).toBe("c");
  });
  it("renders the phone toggle, closed, only when there is more than one row", () => {
    const html = render({ collapsible: true });
    expect(html).toContain('data-role="v3-activity-toggle"');
    expect(html).toMatch(/data-role="v3-activity-toggle"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/data-role="v3-activity-toggle"[^>]*class="[^"]*\bmd:hidden\b/);
    expect(render({ collapsible: true, events: [THREE[0]] })).not.toContain('data-role="v3-activity-toggle"');
  });
  it("not collapsible (desktop console today, and every caller that omits it): no toggle, no hidden row", () => {
    const html = render({});
    expect(html).not.toContain('data-role="v3-activity-toggle"');
    expect(liTags(html).some((x) => x.includes("max-md:hidden"))).toBe(false);
  });
});
