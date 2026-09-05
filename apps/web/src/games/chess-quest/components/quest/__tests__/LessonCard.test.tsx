// Lesson card phone order (design of record: "Quest hub on a phone" — Today
// first). Driven live at 320 the first build put the Play button at 824px:
// the card's Learn/Play/Tip copy sat above the actions. On phones the actions
// row now moves up under the title with `max-md:order-*`; desktop keeps source
// order because no `order` applies there. Markup-level pins only — vitest has
// no DOM — the live geometry is proven by e2e/games-phone.spec.ts.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProgressProvider } from "../../../lib/progress";
import { CopyProvider } from "../../../lib/copy";
import { LessonCard } from "../LessonCard";

const html = renderToStaticMarkup(
  <ProgressProvider>
    <CopyProvider>
      <LessonCard n={1} onPlay={() => {}} />
    </CopyProvider>
  </ProgressProvider>,
);

// Anchored on the quote/space before the token so `md:order-3` cannot match
// inside `max-md:order-3` and pass on its own inversion.
const cls = (name: string) =>
  new RegExp(`["\\s]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s"]`);

const openingTag = (attr: string) => {
  const at = html.indexOf(attr);
  expect(at, `no element carries ${attr}`).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
};

describe("LessonCard — phone order puts the actions under the title", () => {
  it("is a flex column whose actions row is order 3 on phones, after eyebrow (1) and title (2)", () => {
    const card = html.slice(0, html.indexOf(">") + 1);
    expect(card).toMatch(cls("flex-col"));
    const actions = openingTag('data-cq-slot="lesson-actions"');
    expect(actions).toMatch(cls("max-md:order-3"));
    const h2 = html.slice(html.lastIndexOf("<h2", html.indexOf("Board Land")), html.indexOf("Board Land"));
    expect(h2).toMatch(cls("max-md:order-2"));
  });

  it("sends the Learn/Play/Tip copy below the actions on phones (order 4)", () => {
    const dl = html.slice(html.indexOf("<dl"), html.indexOf(">", html.indexOf("<dl")) + 1);
    expect(dl).toMatch(cls("max-md:order-4"));
  });

  it("uses no desktop order override, so ≥768 keeps source order (copy, then actions)", () => {
    expect(html).not.toMatch(cls("md:order-3"));
    expect(html.indexOf("<dl")).toBeLessThan(html.indexOf('data-cq-slot="lesson-actions"'));
  });

  it("keeps both actions at the 44px phone floor", () => {
    const actions = html.slice(html.indexOf('data-cq-slot="lesson-actions"'));
    const buttons = actions.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const b of buttons.slice(0, 2)) expect(b).toMatch(cls("max-md:min-h-11"));
  });
});
