// RS005 W2b — the join-code copy control (task 2). A small "use client"
// leaf: the surrounding row/detail stay server components (no <details>
// onToggle, matching W2a's zero-client-JS surface, task 1) — this is the
// ONE genuinely interactive piece, scoped to exactly the copy button.
//
// Rendered with the `renderIsland` hook harness (./_hook-harness) — the
// same one extra-orgs-control.test.tsx uses for a useState-driven click —
// rather than jsdom (this workspace has none, see the harness's own header).
import { describe, expect, it, vi, afterEach } from "vitest";
import { propsOf, renderIsland, textOf } from "./_hook-harness";
import { RegistrationHubRegistrantJoinCode } from "@/components/registration-hub-registrant-join-code";

const PROPS = {
  code: "TEAM-4F2A",
  label: "Join code",
  hint: "Anyone with this code can add players to this entry.",
  copyLabel: "Copy",
  copiedLabel: "Copied",
};

function mount(overrides: Partial<typeof PROPS> = {}) {
  return renderIsland(RegistrationHubRegistrantJoinCode, { ...PROPS, ...overrides });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RegistrationHubRegistrantJoinCode — initial render", () => {
  it("shows the code, the label, the hint, and the Copy button", () => {
    const island = mount();
    const text = textOf(island.tree() as never);
    expect(text).toContain("TEAM-4F2A");
    expect(text).toContain("Join code");
    expect(text).toContain("Anyone with this code can add players to this entry.");
    expect(text).toContain("Copy");
    expect(text).not.toContain("Copied");
  });

  it("carries a data hook for e2e/regression targeting", () => {
    const island = mount();
    const root = island.tree()[0]!;
    expect(propsOf(root)).toHaveProperty("data-registration-hub-registrant-join-code");
  });
});

describe("RegistrationHubRegistrantJoinCode — copy", () => {
  it("writes the code to the clipboard and flips the button to the copied label", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const island = mount();
    const button = island.tree().find((el) => textOf(el as never) === "Copy")!;
    await (propsOf(button).onClick as () => Promise<void>)();

    expect(writeText).toHaveBeenCalledWith("TEAM-4F2A");
    // Re-find the button on the POST-click tree — its own text must now read
    // exactly "Copied", not still (or also) "Copy".
    const flipped = island.tree().find((el) => textOf(el as never) === "Copied");
    expect(flipped).toBeTruthy();
    expect(island.tree().find((el) => textOf(el as never) === "Copy")).toBeUndefined();
  });

  it("never throws when the clipboard API is unavailable (blocked permission etc.)", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("blocked");
        }),
      },
    });

    const island = mount();
    const button = island.tree().find((el) => textOf(el as never) === "Copy")!;
    await expect((propsOf(button).onClick as () => Promise<void>)()).resolves.not.toThrow();
  });
});
