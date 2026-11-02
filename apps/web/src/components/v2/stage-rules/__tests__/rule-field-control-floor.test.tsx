// Match Day E1 fix round 1 (m7): the 44px tap floor belongs to the CONTROL, not to one editor's wrapper. `RuleFieldControl` is shared by
// the stage card's panel, the Division rules strip, the division builder and the fixture's match rules block; only the first scoped the
// floor with a `[&_input]:min-h-11` rule on its own wrapper, so the others drew the shared 42px `.input` / `.select`. Rendered ALONE here
// - no wrapper around it - so the class has to be on the element itself. (The pixel is measured by the mobile e2e; a class scan cannot see it.)
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { visibleRuleFields } from "@/lib/match-rules";
import { RuleFieldControl } from "../rule-field-control";

describe("RuleFieldControl: every number input and every select holds the 44px floor on its own, for every sport", () => {
  it("each field of each sport, rendered with no wrapper: its input / select carries min-h-11", () => {
    let fields = 0;
    let inputs = 0;
    let selects = 0;
    const lacking: string[] = [];
    for (const m of builtinModules) {
      for (const field of visibleRuleFields(m.key, {}, {})) {
        const html = renderToStaticMarkup(
          <DictProvider dict={enUi as Dict} locale="en">
            <RuleFieldControl sportKey={m.key} field={field} value="" onEdit={() => undefined} />
          </DictProvider>,
        );
        fields++;
        for (const tag of html.match(/<(input|select)\b[^>]*>/g) ?? []) {
          if (tag.startsWith("<input")) inputs++;
          else selects++;
          // The ordered list's own controls are buttons and selects of its own (sequence-field.tsx), measured by the e2e; skip them here.
          if (field.kind === "sequence") continue;
          if (!/\bclass="[^"]*\bmin-h-11\b/.test(tag)) lacking.push(`${m.key}.${field.key}: ${tag}`);
        }
      }
    }
    expect(lacking, "controls without the floor on themselves").toEqual([]);
    // Anti-vacuity: both kinds of control were reached, across a real number of fields.
    expect(fields, "fields rendered").toBeGreaterThan(builtinModules.length * 3);
    expect(inputs, "number inputs seen").toBeGreaterThan(10);
    expect(selects, "selects seen").toBeGreaterThan(10);
  });
});
