// RS005 W2b - the join-code copy control (task 2); polish wave P6 made it the FULL join link. A small "use client"
// leaf: the surrounding row/detail stay server components (no <details>
// onToggle, matching W2a's zero-client-JS surface, task 1) - this is the
// ONE genuinely interactive piece, scoped to exactly the copy button.
//
// Rendered with the `renderIsland` hook harness (./_hook-harness) - the
// same one extra-orgs-control.test.tsx uses for a useState-driven click -
// rather than jsdom (this workspace has none, see the harness's own header).
import { describe, expect, it, vi, afterEach } from "vitest";
import { propsOf, renderIsland, textOf } from "./_hook-harness";
import { RegistrationHubRegistrantJoinCode } from "@/components/registration-hub-registrant-join-code";

const ORIGIN = "https://seazn.test";
const CODE = "SZ-4F2A-9KQ3";
const PATH = `/live/riverside/summer-league/register/join?join_code=${CODE}`;

const PROPS = {
  joinPath: PATH,
  label: "Join link",
  hint: "Anyone with this link can add players to this entry.",
  copyLabel: "Copy link",
  copiedLabel: "Copied",
};

function mount(overrides: Partial<typeof PROPS> = {}, opts?: { hydrate: boolean }) {
  return renderIsland(RegistrationHubRegistrantJoinCode, { ...PROPS, ...overrides }, undefined, opts);
}

function stubBrowser(writeText: (text: string) => Promise<void>, origin = ORIGIN) {
  vi.stubGlobal("window", { location: { origin } });
  vi.stubGlobal("navigator", { clipboard: { writeText } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RegistrationHubRegistrantJoinCode - initial render", () => {
  it("shows the link, the label, the hint, and the Copy link button", () => {
    stubBrowser(async () => {});
    const island = mount();
    const text = textOf(island.tree() as never);
    expect(text).toContain(PATH);
    expect(text).toContain("Join link");
    expect(text).toContain("Anyone with this link can add players to this entry.");
    expect(text).toContain("Copy link");
    expect(text).not.toContain("Copied");
  });

  it("the server render shows the site-relative path; once hydrated it reads as the absolute link it will copy", () => {
    stubBrowser(async () => {});
    const codeText = (island: ReturnType<typeof mount>) => textOf(island.tree().find((e) => e.type === "code") as never);
    expect(codeText(mount())).toBe(PATH);
    expect(codeText(mount({}, { hydrate: true }))).toBe(`${ORIGIN}${PATH}`);
  });

  it("the link is a capability, so the element that paints it is `ph-no-capture` (the recorder drops its text)", () => {
    stubBrowser(async () => {});
    const codeEl = mount().tree().find((e) => e.type === "code")!;
    expect(String(propsOf(codeEl).className)).toMatch(/(^|\s)ph-no-capture(\s|$)/);
  });

  it("carries a data hook for e2e/regression targeting", () => {
    const island = mount();
    const root = island.tree()[0]!;
    expect(propsOf(root)).toHaveProperty("data-registration-hub-registrant-join-code");
  });
});

describe("RegistrationHubRegistrantJoinCode - copy", () => {
  it("writes the FULL link (origin + join path) to the clipboard and flips the button to the copied label - never the bare code", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    stubBrowser(writeText);

    const island = mount();
    const button = island.tree().find((el) => textOf(el as never) === "Copy link")!;
    await (propsOf(button).onClick as () => Promise<void>)();

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(`${ORIGIN}${PATH}`);
    expect(writeText).not.toHaveBeenCalledWith(CODE);
    // Re-find the button on the POST-click tree - its own text must now read
    // exactly "Copied", not still (or also) "Copy link".
    const flipped = island.tree().find((el) => textOf(el as never) === "Copied");
    expect(flipped).toBeTruthy();
    expect(island.tree().find((el) => textOf(el as never) === "Copy link")).toBeUndefined();
  });

  it("copies the origin the page is on at click time, not a captured one (the same component on two origins copies two links)", async () => {
    const seen: string[] = [];
    for (const origin of ["https://seazn.club", "https://stg.seazn.club"]) {
      stubBrowser(async (text) => void seen.push(text), origin);
      const island = mount();
      const button = island.tree().find((el) => textOf(el as never) === "Copy link")!;
      await (propsOf(button).onClick as () => Promise<void>)();
    }
    expect(seen).toEqual([`https://seazn.club${PATH}`, `https://stg.seazn.club${PATH}`]);
  });

  it("never throws when the clipboard API is unavailable (blocked permission etc.), and the label does not flip", async () => {
    stubBrowser(async () => {
      throw new Error("blocked");
    });

    const island = mount();
    const button = island.tree().find((el) => textOf(el as never) === "Copy link")!;
    await expect((propsOf(button).onClick as () => Promise<void>)()).resolves.not.toThrow();
    expect(island.tree().find((el) => textOf(el as never) === "Copied")).toBeUndefined();
  });
});
