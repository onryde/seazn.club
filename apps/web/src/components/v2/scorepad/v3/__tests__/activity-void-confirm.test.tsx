// apps/web/src/components/v2/scorepad/v3/__tests__/activity-void-confirm.test.tsx
// Void is a single scroll-tap away on a phone, so it is two-step: the first tap
// arms the row, the second (`v3-activity-void-confirm`) writes the void. The
// tap flow itself needs a DOM — this workspace's vitest is `environment: "node"`
// — and is proved by e2e/scorepad-v3-cricket.spec.ts. This pins the resting
// state: every voidable row offers Void, and NO row starts out armed.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityPanel, type ActivityEvent, type ActivityPanelProps } from "../activity";
import en from "../../../../../dictionaries/en/ui.json";
import es from "../../../../../dictionaries/es/ui.json";
import fr from "../../../../../dictionaries/fr/ui.json";
import nl from "../../../../../dictionaries/nl/ui.json";

const events: ActivityEvent[] = [
  { id: "a", seq: 1, type: "core.point", payload: {}, voids: null },
  { id: "b", seq: 2, type: "core.point", payload: {}, voids: null },
];
const t = ((key: string) => key) as unknown as ActivityPanelProps["t"];

describe("ActivityPanel two-step void", () => {
  it("rests unarmed: each row offers Void and none offers Confirm", () => {
    const html = renderToStaticMarkup(
      <ActivityPanel
        events={events}
        ownEventIds={new Set()}
        deviceLinkId={null}
        personNames={{}}
        t={t}
        onVoid={() => {}}
        authority
      />,
    );
    expect(html.match(/data-role="v3-activity-void"/g)).toHaveLength(2);
    expect(html).not.toContain('data-role="v3-activity-void-confirm"');
    expect(html).not.toContain('data-role="v3-activity-void-cancel"');
  });

  it("has both new strings in every locale", () => {
    for (const dict of [en, es, fr, nl] as Record<string, string>[]) {
      expect(dict["pad.activity.voidConfirm"]).toBeTruthy();
      expect(dict["pad.activity.voidCancel"]).toBeTruthy();
    }
  });
});
