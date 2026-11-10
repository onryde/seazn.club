// W4 app-A Task 19 (X-LE-10 desk half; R24 pick 1A; b6a carry B3 #5): the stage card's "Waiting to join the bracket" strip.
// An automatic arrival (a paid registration, a waitlist promotion, an import, a Reinstate) into a started root knockout is
// never placed by the app; the card lists each such player with ONE tap, "Add to bracket", that posts the T11 place route
// and says what it did. A refused tap (no slot left) is never a stuck amber row: it leaves exits — Withdraw, a refund
// pointer for a paid entry, and Rebuild when nothing has started.
//
// Driven through the real island (shared node-env hook harness; no DOM): the button's own onClick, the mocked wire, the
// re-rendered strip read back. Expected sentences are the approved English typed out here (task-19 brief, R24 page), never
// read off the component. Single-sport by nature: the strip reads a result's case and the waiting list; no sport field
// reaches it.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";

const net = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  answers: [] as (() => unknown)[],
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      net.calls.push({ url, method: options?.method, json: options?.json });
      const next = net.answers.shift();
      if (!next) return Promise.reject(new Error(`no answer queued for ${url}`));
      try {
        return Promise.resolve(next());
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
});
const router = vi.hoisted(() => ({ refreshCount: 0 }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => { router.refreshCount += 1; } }) }));
const confirmMock = vi.hoisted(() => ({ resolve: true, calls: [] as { title: string; body: unknown; confirmLabel: string; tone?: string }[] }));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => (opts: { title: string; body: unknown; confirmLabel: string; tone?: string }) => {
    confirmMock.calls.push(opts);
    return Promise.resolve(confirmMock.resolve);
  },
}));

import { ApiV1Error } from "@/lib/client-v1";
import type { KnockoutLateEntryResult } from "@/server/api-v1/schemas";
import { KnockoutWaitingStrip } from "../knockout-waiting-strip";

const STAGE = "stage-1";
const OLIVER = { entrantId: "e-oliver", stageId: STAGE, name: "Oliver Grant", paid: false };
const NORA = { entrantId: "e-nora", stageId: STAGE, name: "Nora Lind", paid: true };
const NAMES = { "e-oliver": "Oliver Grant", "e-nora": "Nora Lind", "e-arjun": "Arjun Menon", "e-rasmus": "Rasmus Holm", "e-farhan": "Farhan Iqbal" };
const REGISTRATIONS = "/o/club/c/open/registration?tab=registrants&division_id=d1";

interface Calls {
  rebuild: number;
  placed: { done: string[]; todo: string[] }[];
}
function mount(waiting = [OLIVER, NORA], calls: Calls = { rebuild: 0, placed: [] }) {
  const island = renderIsland(KnockoutWaitingStrip, {
    stageId: STAGE,
    waiting,
    names: NAMES,
    registrationsHref: REGISTRATIONS,
    onRebuild: () => {
      calls.rebuild += 1;
    },
    onPlaced: (said: { done: string[]; todo: string[] }) => {
      calls.placed.push(said);
    },
  });
  return { island, calls };
}
const byTestId = (tree: ReturnType<typeof walk>, id: string) => tree.filter((e) => propsOf(e)["data-testid"] === id);
const result = (o: Partial<KnockoutLateEntryResult> & Pick<KnockoutLateEntryResult, "case">): KnockoutLateEntryResult => ({
  format: "knockout",
  entrant_id: "e-oliver",
  stage_id: STAGE,
  ...o,
});
const tapOf = (island: ReturnType<typeof mount>["island"], i = 0) =>
  propsOf(byTestId(island.tree(), "knockout-waiting-place")[i]!).onClick as () => Promise<void>;

beforeEach(() => {
  net.calls = [];
  net.answers = [];
  router.refreshCount = 0;
  confirmMock.resolve = true;
  confirmMock.calls = [];
});

describe("X-LE-10 the waiting strip", () => {
  it("the empty case first: nobody waiting renders nothing (no title, no button)", () => {
    const { island } = mount([]);
    expect(island.tree()).toEqual([]);
    expect(island.text()).toBe("");
    // positive pair: with someone waiting the same island does render
    expect(mount([OLIVER]).island.text()).toContain("Waiting to join the bracket");
  });

  it("lists each waiting player with one 'Add to bracket' and the why, a paid entry said as paid", () => {
    const { island } = mount();
    const text = island.text();
    expect(text).toContain("Waiting to join the bracket");
    expect(text).toContain("Oliver Grant");
    expect(text).toContain("Joined after the draw. Not in the bracket yet.");
    expect(text).toContain("Nora Lind");
    expect(text).toContain("Paid online after the draw. Not in the bracket yet.");
    const rows = byTestId(island.tree(), "knockout-waiting-row");
    expect(rows.map((r) => propsOf(r)["data-entrant-id"])).toEqual(["e-oliver", "e-nora"]);
    const buttons = byTestId(island.tree(), "knockout-waiting-place");
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(textOf(b)).toBe("Add to bracket");
  });

  it("the tap posts the place route for THAT player and, when it seats them, says so and refreshes once", async () => {
    net.answers.push(() => result({ case: "bye", fixture_id: "f1", opponent_id: "e-arjun", scheduled: true }));
    const { island, calls } = mount();
    await tapOf(island, 0)();
    expect(net.calls).toEqual([{ url: `/api/v1/stages/${STAGE}/late-entrants/e-oliver/place`, method: "POST", json: {} }]);
    expect(calls.placed).toEqual([{ done: ["Oliver Grant plays Arjun Menon, who had a bye."], todo: [] }]);
    expect(router.refreshCount).toBe(1);
    expect(calls.rebuild).toBe(0);
  });

  it("the second player's tap posts the second player's id (the join between the row and the route)", async () => {
    net.answers.push(() => result({ case: "withdrawn_slot", entrant_id: "e-nora", fixture_id: "f2", opponent_id: "e-rasmus", withdrawn_id: "e-farhan", scheduled: false }));
    const { island, calls } = mount();
    await tapOf(island, 1)();
    expect(net.calls[0]!.url).toBe(`/api/v1/stages/${STAGE}/late-entrants/e-nora/place`);
    expect(calls.placed).toEqual([
      { done: ["Nora Lind takes Farhan Iqbal's place against Rasmus Holm."], todo: ["1 new match is unscheduled."] },
    ]);
  });

  it("a refused tap (no slot) is not a landing: nothing is placed or refreshed, the reason shows, and the exits appear", async () => {
    net.answers.push(() => result({ case: "refused", reason: "KO_LATE_ENTRY_NO_SLOT" }));
    const { island, calls } = mount([OLIVER]);
    // before the tap: no exits (the empty case of the exit set)
    expect(byTestId(island.tree(), "knockout-waiting-withdraw")).toHaveLength(0);
    await tapOf(island)();
    expect(calls.placed).toEqual([]);
    expect(router.refreshCount).toBe(0);
    expect(island.text()).toContain("Round 1 complete; no slot left.");
    const out = byTestId(island.tree(), "knockout-waiting-outcome");
    expect(out).toHaveLength(1);
    expect(textOf(byTestId(island.tree(), "knockout-waiting-withdraw")[0]!)).toBe("Withdraw");
    // the player is still waiting: the tap is still offered (a second try after the organiser made room)
    expect(byTestId(island.tree(), "knockout-waiting-place")).toHaveLength(1);
    // unpaid: no refund pointer; nothing has "started" a Rebuild offer
    expect(byTestId(island.tree(), "knockout-waiting-refund")).toHaveLength(0);
    expect(byTestId(island.tree(), "knockout-waiting-rebuild")).toHaveLength(0);
  });

  it("a refused PAID entry points at the refund in Registrations (the link is the registrations hub, filtered)", async () => {
    net.answers.push(() => result({ case: "refused", entrant_id: "e-nora", reason: "KO_LATE_ENTRY_NO_SLOT" }));
    const { island } = mount([NORA]);
    await tapOf(island)();
    const refund = byTestId(island.tree(), "knockout-waiting-refund");
    expect(refund).toHaveLength(1);
    expect(textOf(refund[0]!)).toBe("Refund in Registrations");
    expect(propsOf(refund[0]!).href).toBe(REGISTRATIONS);
    expect(byTestId(island.tree(), "knockout-waiting-withdraw")).toHaveLength(1);
  });

  it("rebuild_offered (nothing has started): the sentence and a Rebuild exit that runs the panel's own Rebuild", async () => {
    net.answers.push(() => result({ case: "rebuild_offered", reason: "KO_LATE_ENTRY_NO_SLOT" }));
    const { island, calls } = mount([OLIVER]);
    await tapOf(island)();
    expect(island.text()).toContain("No slot is left, but nothing has started: use Rebuild fixtures to add Oliver Grant.");
    const rebuild = byTestId(island.tree(), "knockout-waiting-rebuild");
    expect(rebuild).toHaveLength(1);
    expect(textOf(rebuild[0]!)).toBe("Rebuild fixtures");
    (propsOf(rebuild[0]!).onClick as () => void)();
    expect(calls.rebuild).toBe(1);
    expect(net.calls).toHaveLength(1); // the strip itself posted nothing for Rebuild: the panel's own confirm owns it
  });

  it("m1 the schedule frozen (nothing started): the unfreeze-first sentence, the player still waiting, and NO Rebuild exit", async () => {
    // Final review m1 (owner ruling 2026-11-09): Rebuild refuses a frozen schedule, so the strip offers no Rebuild button.
    net.answers.push(() => result({ case: "refused", reason: "KO_LATE_ENTRY_SCHEDULE_FROZEN" }));
    const { island, calls } = mount([OLIVER]);
    await tapOf(island)();
    expect(calls.placed).toEqual([]);
    expect(router.refreshCount).toBe(0);
    expect(island.text()).toContain(
      "No slot is left, and the schedule is frozen: unfreeze it on the Schedule page, then use Rebuild fixtures to add Oliver Grant.",
    );
    expect(byTestId(island.tree(), "knockout-waiting-rebuild"), "no Rebuild while frozen").toHaveLength(0);
    expect(byTestId(island.tree(), "knockout-waiting-place"), "still waiting: the tap stays").toHaveLength(1);
    expect(byTestId(island.tree(), "knockout-waiting-withdraw"), "the other exits stay").toHaveLength(1);
  });

  it("Withdraw: declined posts nothing; confirmed posts the withdraw route and refreshes (sequence: after a refusal)", async () => {
    net.answers.push(() => result({ case: "refused", reason: "KO_LATE_ENTRY_NO_SLOT" }));
    const { island } = mount([OLIVER]);
    await tapOf(island)();
    const withdraw = () => propsOf(byTestId(island.tree(), "knockout-waiting-withdraw")[0]!).onClick as () => Promise<void>;
    confirmMock.resolve = false;
    await withdraw()();
    expect(net.calls).toHaveLength(1); // only the tap
    expect(confirmMock.calls).toHaveLength(1);
    expect(confirmMock.calls[0]!.title).toBe("Withdraw Oliver Grant?");
    expect(confirmMock.calls[0]!.tone).toBe("danger");
    expect(confirmMock.calls[0]!.body).toBe("Oliver Grant isn't in the bracket yet, so no match is affected. They stay on the entrant list as withdrawn.");
    expect(router.refreshCount).toBe(0);
    confirmMock.resolve = true;
    net.answers.push(() => ({}));
    await withdraw()();
    expect(net.calls[1]).toEqual({ url: "/api/v1/entrants/e-oliver/withdraw", method: "POST", json: {} });
    expect(router.refreshCount).toBe(1);
  });

  it("a second tap after a refusal starts clean: the first sentence goes, the new answer's is said", async () => {
    net.answers.push(() => result({ case: "refused", reason: "KO_LATE_ENTRY_NO_SLOT" }));
    net.answers.push(() => result({ case: "bye", fixture_id: "f1", opponent_id: "e-arjun", scheduled: true }));
    const { island, calls } = mount([OLIVER]);
    await tapOf(island)();
    expect(island.text()).toContain("Round 1 complete; no slot left.");
    await tapOf(island)();
    expect(island.text()).not.toContain("Round 1 complete; no slot left.");
    expect(byTestId(island.tree(), "knockout-waiting-outcome")).toHaveLength(0);
    expect(calls.placed).toHaveLength(1);
    expect(router.refreshCount).toBe(1);
  });

  it("a server refusal (409) is said in the organiser's language by its code, and the stale list is refreshed", async () => {
    net.answers.push(() => {
      throw new ApiV1Error("The server's English", 409, "KO_LATE_ENTRY_NOT_WAITING", {});
    });
    const { island, calls } = mount([OLIVER]);
    await tapOf(island)();
    expect(island.text()).toContain("This player isn't waiting to join this bracket.");
    expect(calls.placed).toEqual([]);
    expect(router.refreshCount).toBe(1);
  });

  it("a fed stage's refusal fills its {stage} placeholder from the envelope", async () => {
    net.answers.push(() => {
      throw new ApiV1Error("The server's English", 422, "KO_LATE_ENTRY_FED_STAGE", { stage: "Group stage" });
    });
    const { island } = mount([OLIVER]);
    await tapOf(island)();
    expect(island.text()).toContain("This knockout is filled from Group stage. Add the player there.");
  });

  // B6a fix round 1 (review #5): a failure that is not a knockout refusal is never shown as it came (an English network or
  // server string); it is a localized generic line, and the wire's own text appears nowhere.
  it("a failure that is not a knockout refusal is a localized generic line - never the raw error text - and never lands", async () => {
    net.answers.push(() => {
      throw new Error("Network down");
    });
    const { island, calls } = mount([OLIVER]);
    await tapOf(island)();
    expect(island.text()).toContain("Something went wrong. Try again.");
    expect(island.text()).not.toContain("Network down");
    expect(calls.placed).toEqual([]);
    expect(router.refreshCount).toBe(0);
    // an unmapped server answer is the same line (its English message is not the organiser's language)
    net.answers.push(() => {
      throw new ApiV1Error("Internal Server Error: pq: deadlock detected", 500, "INTERNAL", {});
    });
    await tapOf(island)();
    expect(island.text()).toContain("Something went wrong. Try again.");
    expect(island.text()).not.toContain("deadlock");
  });

  it("Withdraw failing is said by its code like the other refusals, else the generic line - never err.message - and the exits stay", async () => {
    net.answers.push(() => result({ case: "refused", reason: "KO_LATE_ENTRY_NO_SLOT" }));
    const { island } = mount([OLIVER]);
    await tapOf(island)();
    const withdraw = () => propsOf(byTestId(island.tree(), "knockout-waiting-withdraw")[0]!).onClick as () => Promise<void>;
    net.answers.push(() => {
      throw new ApiV1Error("The server's English", 409, "KO_LATE_ENTRY_NOT_WAITING", {});
    });
    await withdraw()();
    expect(island.text()).toContain("This player isn't waiting to join this bracket.");
    expect(island.text()).not.toContain("The server's English");
    net.answers.push(() => {
      throw new Error("fetch failed: ECONNRESET");
    });
    await withdraw()();
    expect(island.text()).toContain("Something went wrong. Try again.");
    expect(island.text()).not.toContain("ECONNRESET");
    expect(byTestId(island.tree(), "knockout-waiting-withdraw"), "the exit stays for another try").toHaveLength(1);
    expect(router.refreshCount).toBe(0);
  });

  // The 200 that PLACED the player but whose sentence cannot be built (a reply missing a field its sentence names): the player
  // is in the bracket, so the page is re-read and the organiser told - in a localized generic line - that they are in. Main
  // showed the notice builder's internal English error, left the strip stale and the player listed as waiting.
  it("a placing 200 whose sentence cannot be built still refreshes and says a localized generic success - never the internal error", async () => {
    let checked = 0;
    for (const partial of [result({ case: "bye", fixture_id: "f1" }), result({ case: "withdrawn_slot", fixture_id: "f1", opponent_id: "e-arjun" })]) {
      net.calls = [];
      router.refreshCount = 0;
      net.answers.push(() => partial);
      const { island, calls } = mount([OLIVER]);
      await tapOf(island)();
      expect(calls.placed, partial.case).toEqual([{ done: ["Oliver Grant was added to the bracket."], todo: [] }]);
      expect(router.refreshCount, `${partial.case}: the page is re-read`).toBe(1);
      expect(island.text(), partial.case).not.toContain("knockout late entry");
      expect(byTestId(island.tree(), "knockout-waiting-outcome"), `${partial.case}: no error row`).toHaveLength(0);
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("a refusal whose sentence cannot be built is the generic line with the exits (nothing was placed, so nothing refreshes)", async () => {
    net.answers.push(() => result({ case: "refused", reason: "SOMETHING_ELSE" }));
    const { island, calls } = mount([OLIVER]);
    await tapOf(island)();
    expect(island.text()).toContain("Something went wrong. Try again.");
    expect(island.text()).not.toContain("knockout late entry");
    expect(calls.placed).toEqual([]);
    expect(router.refreshCount).toBe(0);
    expect(byTestId(island.tree(), "knockout-waiting-withdraw"), "the exits stay").toHaveLength(1);
  });

  // B6a fix round 1 (review #3): a seat holder whose place was played on is answered `refused` / KO_LATE_ENTRY_PLAYED_ON and the
  // server CLEARS their flag - so the answer is a landing, not a stuck row: the sentence goes to the panel's amber line (it
  // outlives the strip) and the page is re-read, which takes them off the card.
  it("'played on' (a seat holder whose place is gone): said in the panel's amber line, the page re-read - no stuck row, no exits", async () => {
    net.answers.push(() => result({ case: "refused", reason: "KO_LATE_ENTRY_PLAYED_ON" }));
    const { island, calls } = mount([OLIVER]);
    await tapOf(island)();
    expect(calls.placed).toEqual([{ done: [], todo: ["Oliver Grant is back on the list, but their place in the bracket has been played on."] }]);
    expect(router.refreshCount).toBe(1);
    expect(byTestId(island.tree(), "knockout-waiting-outcome")).toHaveLength(0);
    expect(byTestId(island.tree(), "knockout-waiting-withdraw")).toHaveLength(0);
  });

  it("a tap while one is in flight is ignored (one place per press)", async () => {
    let release: (() => void) | null = null;
    net.answers.push(() => result({ case: "bye", fixture_id: "f1", opponent_id: "e-arjun", scheduled: true }));
    // Hold the first answer: the mock resolves immediately, so gate it behind a promise the test releases.
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const original = net.answers.shift()!;
    net.answers.push(() => gate.then(original) as unknown);
    const { island, calls } = mount();
    const first = tapOf(island, 0)();
    const second = tapOf(island, 1)(); // a second player's tap, while the first is posting
    release!();
    await Promise.all([first, second]);
    expect(net.calls.map((c) => c.url)).toEqual([`/api/v1/stages/${STAGE}/late-entrants/e-oliver/place`]);
    expect(calls.placed).toHaveLength(1);
  });
});

// The strip's two new lines (B6a fix round 1) exist in every language, translated, with the placeholder the English one has.
describe("the strip's failure and generic-success lines are in all four dictionaries", () => {
  it("each locale has both keys, translated, with the English placeholders", async () => {
    const dicts = {
      en: (await import("@/dictionaries/en/ui.json")).default,
      es: (await import("@/dictionaries/es/ui.json")).default,
      fr: (await import("@/dictionaries/fr/ui.json")).default,
      nl: (await import("@/dictionaries/nl/ui.json")).default,
    } as unknown as Record<string, Record<string, string>>;
    const placeholders = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    let checked = 0;
    for (const key of ["knockout.waiting.failed", "knockout.waiting.placed"]) {
      expect(placeholders(dicts.en![key]!), `premise: en ${key}`).toEqual(key.endsWith("placed") ? ["name"] : []);
      for (const [locale, dict] of Object.entries(dicts)) {
        expect(typeof dict[key] === "string" && dict[key]!.trim() !== "", `${locale}/${key}`).toBe(true);
        expect(placeholders(dict[key]!), `${locale}/${key} placeholders`).toEqual(placeholders(dicts.en![key]!));
        if (locale !== "en") expect(dict[key], `${locale}/${key} is translated`).not.toBe(dicts.en![key]);
        checked++;
      }
    }
    expect(checked, "anti-vacuity: two keys x four locales").toBe(8);
  });
});
