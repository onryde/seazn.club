// Date/time UX programme, Prompt 06 — the blackout-window editor.
//
// Before this, `config.blackouts` could only be written by the AI natural-
// language console: the constraints panel showed nothing at all for it, and the
// settings panel's play-hours slot pointed organisers at "the constraints
// panel" for windows that panel had never been able to edit. This suite pins
// the form that closes that gap, and the copy that stops pointing at a dead end.
//
// Two shapes are in play and they are NOT the same:
//   * stored/wire (`schemas.ts` ScheduleConfig.blackouts) — `{court?, from, to}`
//     with `from`/`to` as ISO datetimes WITH offset;
//   * engine (`packages/engine/src/scheduling/calendar.ts` Blackout) — the same
//     keys with `from`/`to` as epoch ms.
// The panel talks to the API, so it writes ISO. Every expectation below is
// derived through the same conversion the browser would do rather than
// hardcoded, because the node TZ shifts a local-input string.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import {
  blackoutRowError,
  ConstraintsPanel,
  draftsToBlackouts,
  toBlackoutDrafts,
  type BlackoutDraft,
} from "../constraints-panel";
import { StandaloneScheduleSettings } from "@/components/v2/board/settings-panel";
import { zonedDateTimeInput } from "@/lib/zoned-datetime";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { BoardConfig } from "@/components/v2/board/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// `useConfirm` THROWS outside its provider (the context default is null), and
// the harness has no provider tree. Mocked to the "user said yes" path — no
// blackout action goes through it, only the pre-existing bulk shift does.
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async () => true,
}));

const api = vi.hoisted(() => ({
  calls: [] as { url: string; options?: { method?: string; json?: unknown } }[],
  /** Set to make the next PUT reject, for the entitlement path. */
  putRejects: null as null | (() => unknown),
  storedConfig: {} as Record<string, unknown>,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class — `instanceof` picks the 402 branch.
    apiV1: vi.fn(async (url: string, options?: { method?: string; json?: unknown }) => {
      api.calls.push({ url, options });
      if (options?.method === "PUT") {
        if (api.putRejects) throw api.putRejects();
        return {};
      }
      return { division_id: "d1", config: api.storedConfig };
    }),
  };
});

const FROM_ISO = "2026-08-01T12:00:00.000Z";
const TO_ISO = "2026-08-01T13:00:00.000Z";

/** The VENUE clock this editor reads and writes on (`settings.orgTz`, #448).
 *  Non-UTC and not this process's zone, so nothing below can pass by
 *  coincidence against a browser-zone implementation. */
const ORG_TZ = "Pacific/Auckland";

/** The datetime-local string the field shows for an instant, on the VENUE
 *  clock — which is what the panel now renders and parses. */
const local = (iso: string) => zonedDateTimeInput(iso, ORG_TZ);

/** A complete, valid draft — one hour, whole division. */
function validDraft(over: Partial<BlackoutDraft> = {}): BlackoutDraft {
  return { court: "", from: local(FROM_ISO), to: local(TO_ISO), ...over };
}

describe("toBlackoutDrafts — stored rows into editable drafts", () => {
  it("reads ISO instants back as local datetime-input values", () => {
    const drafts = toBlackoutDrafts([{ from: FROM_ISO, to: TO_ISO }], ORG_TZ);
    expect(drafts).toEqual([{ court: "", from: local(FROM_ISO), to: local(TO_ISO) }]);
  });

  it("keeps a court scope, and represents an absent one as the empty string", () => {
    const drafts = toBlackoutDrafts([
      { court: "Court 2", from: FROM_ISO, to: TO_ISO },
      { from: FROM_ISO, to: TO_ISO },
    ], ORG_TZ);
    expect(drafts.map((d) => d.court)).toEqual(["Court 2", ""]);
  });

  it("tolerates a config with no blackouts key at all", () => {
    expect(toBlackoutDrafts(undefined, ORG_TZ)).toEqual([]);
    expect(toBlackoutDrafts(null, ORG_TZ)).toEqual([]);
    expect(toBlackoutDrafts("not an array", ORG_TZ)).toEqual([]);
  });

  it("drops a row whose instants are not strings rather than rendering NaN", () => {
    // `config` is `Record<string, unknown>` on the way in — the panel never
    // re-parses the wire schema, so a malformed row must not become a field
    // showing "Invalid Date".
    const drafts = toBlackoutDrafts([{ from: 123, to: TO_ISO }, null, { from: FROM_ISO, to: TO_ISO }], ORG_TZ);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.from).toBe(local(FROM_ISO));
  });
});

describe("blackoutRowError — what the form refuses to store", () => {
  it("accepts a complete window", () => {
    expect(blackoutRowError(validDraft(), ORG_TZ)).toBeNull();
  });

  it("reports an unfinished row as incomplete, not as an error", () => {
    expect(blackoutRowError(validDraft({ to: "" }), ORG_TZ)).toBe("incomplete");
    expect(blackoutRowError(validDraft({ from: "" }), ORG_TZ)).toBe("incomplete");
    expect(blackoutRowError({ court: "", from: "", to: "" }, ORG_TZ)).toBe("incomplete");
  });

  it("refuses an inverted range", () => {
    expect(blackoutRowError({ court: "", from: local(TO_ISO), to: local(FROM_ISO) }, ORG_TZ)).toBe("order");
  });

  it("refuses a zero-length range", () => {
    // The engine's `to` is EXCLUSIVE (calendar.ts `overlaps(start, end, bo.from,
    // bo.to)`), so from === to blacks out nothing whatsoever. Storing it would
    // be a control that silently does not work.
    expect(blackoutRowError({ court: "", from: local(FROM_ISO), to: local(FROM_ISO) }, ORG_TZ)).toBe("order");
  });

  it("treats an unparseable instant as incomplete", () => {
    expect(blackoutRowError({ court: "", from: "not-a-date", to: local(TO_ISO) }, ORG_TZ)).toBe("incomplete");
  });
});

describe("draftsToBlackouts — drafts into the stored wire shape", () => {
  it("writes ISO instants, not the engine's epoch ms", () => {
    const rows = draftsToBlackouts([validDraft()], ORG_TZ);
    expect(rows).toEqual([{ from: FROM_ISO, to: TO_ISO }]);
    // Guards the shape itself: `schemas.ts` types these as z.iso.datetime, so a
    // number here is a 400 from the PUT, not a silently different unit.
    expect(typeof rows![0]!.from).toBe("string");
  });

  it("omits the court key entirely for a whole-division window", () => {
    const rows = draftsToBlackouts([validDraft()], ORG_TZ);
    // Not `court: undefined` — the wire schema marks it `.optional()`, and an
    // explicit undefined is the difference between "every court" and a key the
    // round-trip has to survive.
    expect(Object.keys(rows![0]!).sort()).toEqual(["from", "to"]);
  });

  it("carries a court scope through, trimmed", () => {
    const rows = draftsToBlackouts([validDraft({ court: " Court 2 " })], ORG_TZ);
    expect(rows).toEqual([{ court: "Court 2", from: FROM_ISO, to: TO_ISO }]);
  });

  it("refuses the whole set when any single row is invalid", () => {
    // All-or-nothing on purpose: a partial write would silently drop the row
    // the organiser was in the middle of typing.
    expect(draftsToBlackouts([validDraft(), validDraft({ to: "" })], ORG_TZ)).toBeNull();
    expect(
      draftsToBlackouts([validDraft(), { court: "", from: local(TO_ISO), to: local(FROM_ISO) }], ORG_TZ),
    ).toBeNull();
  });

  it("allows two windows that overlap", () => {
    // Deliberate: the engine unions blackouts (`courtBlocked` returns on the
    // first match), so an overlap is exactly equivalent to its union and
    // refusing it would block a legitimate "whole site closed, plus Court 2
    // closed longer" pair.
    const rows = draftsToBlackouts([validDraft(), validDraft({ court: "Court 2" })], ORG_TZ);
    expect(rows).toHaveLength(2);
  });

  it("round-trips: stored rows in, identical stored rows out", () => {
    const stored = [
      { from: FROM_ISO, to: TO_ISO },
      { court: "Court 2", from: FROM_ISO, to: TO_ISO },
    ];
    expect(draftsToBlackouts(toBlackoutDrafts(stored, ORG_TZ), ORG_TZ)).toEqual(stored);
  });
});

// ---------------------------------------------------------------------------
// The editor itself. Two render modes, because each can see something the
// other cannot: `renderIsland` drives the component's own state and shows what
// it POSTs; `renderToStaticMarkup` shows the markup a screen reader and a
// stylesheet see. Neither is optional here — the whole point of the prompt is
// that a form now WRITES this field.
// ---------------------------------------------------------------------------

const COURTS = ["Court 1", "Court 2"];

function config(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { courts: COURTS, matchMinutes: 30, gapMinutes: 0, ...over };
}

function panelProps(over: { config?: Record<string, unknown>; canEdit?: boolean } = {}) {
  return {
    divisionId: "d1",
    initialSettings: { division_id: "d1", config: over.config ?? config() },
    canEdit: over.canEdit ?? true,
    orgTz: ORG_TZ,
  };
}

/** React escapes text nodes, so a dictionary sentence is never a raw substring. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function renderPanel(props: ReturnType<typeof panelProps>, dict: Dict = enUi as Dict, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <ConstraintsPanel {...props} />
    </DictProvider>,
  );
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const label = (key: keyof typeof enUi) => enUi[key] as string;
const byText = (els: ReactElement[], type: string, text: string) =>
  els.find((el) => el.type === type && propsOf(el).children === text);
const fieldsIn = (row: ReactElement, name: string) =>
  walk(row).filter((el) => propsOf(el).label === name);

beforeEach(() => {
  api.calls.length = 0;
  api.putRejects = null;
  api.storedConfig = config();
});

describe("blackout editor — writing config.blackouts", () => {
  it("adds a row, and stores it as ISO instants under config.blackouts", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps());

    // Nothing to begin with: no rows, and the empty state invites the first one.
    expect(island.tree().filter((el) => el.type === "li")).toHaveLength(0);
    expect(island.text()).toContain(label("constraints.blackout.empty"));

    (propsOf(byText(island.tree(), "button", label("constraints.blackout.add"))!).onClick as () => void)();

    const row = island.tree().filter((el) => el.type === "li")[0]!;
    (propsOf(fieldsIn(row, label("constraints.blackout.from"))[0]!).onChange as (v: string) => void)(
      local(FROM_ISO),
    );
    (propsOf(fieldsIn(island.tree().filter((el) => el.type === "li")[0]!, label("constraints.blackout.to"))[0]!)
      .onChange as (v: string) => void)(local(TO_ISO));

    (propsOf(byText(island.tree(), "button", label("constraints.blackout.save"))!).onClick as () => void)();
    await flush();

    const put = api.calls.find((c) => c.options?.method === "PUT");
    expect(put, `calls: ${api.calls.map((c) => c.options?.method ?? "GET").join(",")}`).toBeDefined();
    const body = put!.options!.json as { config: { blackouts: unknown[]; courts: string[] } };
    expect(body.config.blackouts).toEqual([{ from: FROM_ISO, to: TO_ISO }]);
    // The PUT re-sends the whole config, so the other keys must survive.
    expect(body.config.courts).toEqual(COURTS);
    // ...and no error surfaced instead.
    expect(island.text()).not.toContain("Failed");
  });

  it("carries the court scope the organiser picked", async () => {
    const island = renderIsland(ConstraintsPanel, panelProps());
    (propsOf(byText(island.tree(), "button", label("constraints.blackout.add"))!).onClick as () => void)();

    const row = () => island.tree().filter((el) => el.type === "li")[0]!;
    const scope = walk(row()).find((el) => el.type === "select")!;
    (propsOf(scope).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "Court 2" },
    });
    (propsOf(fieldsIn(row(), label("constraints.blackout.from"))[0]!).onChange as (v: string) => void)(local(FROM_ISO));
    (propsOf(fieldsIn(row(), label("constraints.blackout.to"))[0]!).onChange as (v: string) => void)(local(TO_ISO));
    (propsOf(byText(island.tree(), "button", label("constraints.blackout.save"))!).onClick as () => void)();
    await flush();

    const body = api.calls.find((c) => c.options?.method === "PUT")!.options!.json as {
      config: { blackouts: unknown[] };
    };
    expect(body.config.blackouts).toEqual([{ court: "Court 2", from: FROM_ISO, to: TO_ISO }]);
  });

  it("removes a row and persists the shorter list", async () => {
    api.storedConfig = config({
      blackouts: [
        { from: FROM_ISO, to: TO_ISO },
        { court: "Court 2", from: FROM_ISO, to: TO_ISO },
      ],
    });
    const island = renderIsland(ConstraintsPanel, panelProps({ config: api.storedConfig }));
    expect(island.tree().filter((el) => el.type === "li")).toHaveLength(2);

    const remove = island
      .tree()
      .find((el) => propsOf(el)["aria-label"] === label("constraints.blackout.remove").replace("{n}", "1"))!;
    (propsOf(remove).onClick as () => void)();
    expect(island.tree().filter((el) => el.type === "li")).toHaveLength(1);

    (propsOf(byText(island.tree(), "button", label("constraints.blackout.save"))!).onClick as () => void)();
    await flush();
    const body = api.calls.find((c) => c.options?.method === "PUT")!.options!.json as {
      config: { blackouts: unknown[] };
    };
    // The SECOND row survives — an off-by-one that dropped the wrong one would
    // still leave a list of length 1.
    expect(body.config.blackouts).toEqual([{ court: "Court 2", from: FROM_ISO, to: TO_ISO }]);
  });

  it("offers no save until something actually changed", () => {
    api.storedConfig = config({ blackouts: [{ from: FROM_ISO, to: TO_ISO }] });
    const island = renderIsland(ConstraintsPanel, panelProps({ config: api.storedConfig }));
    expect(byText(island.tree(), "button", label("constraints.blackout.save"))).toBeUndefined();
    (propsOf(byText(island.tree(), "button", label("constraints.blackout.add"))!).onClick as () => void)();
    expect(byText(island.tree(), "button", label("constraints.blackout.save"))).toBeDefined();
  });
});

describe("blackout editor — what it refuses, and how it says so", () => {
  function rowWith(from: string, to: string) {
    const island = renderIsland(ConstraintsPanel, panelProps());
    (propsOf(byText(island.tree(), "button", label("constraints.blackout.add"))!).onClick as () => void)();
    const row = () => island.tree().filter((el) => el.type === "li")[0]!;
    if (from) (propsOf(fieldsIn(row(), label("constraints.blackout.from"))[0]!).onChange as (v: string) => void)(from);
    if (to) (propsOf(fieldsIn(row(), label("constraints.blackout.to"))[0]!).onChange as (v: string) => void)(to);
    return island;
  }

  it("blocks the save and names the problem when the end is before the start", () => {
    const island = rowWith(local(TO_ISO), local(FROM_ISO));
    const save = byText(island.tree(), "button", label("constraints.blackout.save"))!;
    expect(propsOf(save).disabled).toBe(true);
    expect(island.text()).toContain(label("constraints.blackout.errorOrder"));
  });

  it("blocks the save on a zero-length window, which would black out nothing", () => {
    const island = rowWith(local(FROM_ISO), local(FROM_ISO));
    expect(propsOf(byText(island.tree(), "button", label("constraints.blackout.save"))!).disabled).toBe(true);
    expect(island.text()).toContain(label("constraints.blackout.errorOrder"));
  });

  it("says a half-filled row is unfinished rather than wrong", () => {
    const island = rowWith(local(FROM_ISO), "");
    expect(propsOf(byText(island.tree(), "button", label("constraints.blackout.save"))!).disabled).toBe(true);
    expect(island.text()).toContain(label("constraints.blackout.errorIncomplete"));
    expect(island.text()).not.toContain(label("constraints.blackout.errorOrder"));
  });

  it("bounds the end field with the start the organiser typed", () => {
    const island = rowWith(local(FROM_ISO), "");
    const row = island.tree().filter((el) => el.type === "li")[0]!;
    // A wired-up value, not an absence: only driving the component's own state
    // can show that `min` follows the sibling field.
    expect(propsOf(fieldsIn(row, label("constraints.blackout.to"))[0]!).min).toBe(local(FROM_ISO));
    expect(propsOf(fieldsIn(row, label("constraints.blackout.from"))[0]!).min).toBeUndefined();
  });

  it("re-enables the save once the range is corrected", () => {
    const island = rowWith(local(TO_ISO), local(FROM_ISO));
    const row = () => island.tree().filter((el) => el.type === "li")[0]!;
    (propsOf(fieldsIn(row(), label("constraints.blackout.to"))[0]!).onChange as (v: string) => void)(
      local("2026-08-01T18:00:00.000Z"),
    );
    expect(propsOf(byText(island.tree(), "button", label("constraints.blackout.save"))!).disabled).toBe(false);
    expect(island.text()).not.toContain(label("constraints.blackout.errorOrder"));
  });
});

describe("blackout editor — the scheduling.constraints gate", () => {
  it("renders no editor at all for an org without the feature", () => {
    // The page composes `canEdit={canEdit && !frozen && constraints}`, so a
    // Community-tier org reaches this component with canEdit false.
    const html = renderPanel(panelProps({ canEdit: false }));
    expect(html).not.toContain(escapeHtml(label("constraints.blackout.title")));
    expect(html).not.toContain(escapeHtml(label("constraints.blackout.add")));
    // Guard against a vacuous pass — the rest of the panel still rendered.
    expect(html).toContain(escapeHtml(label("constraints.maxPerDay.label")));
  });

  it("still shows existing windows read-only, so a downgrade hides nothing", () => {
    const html = renderPanel(
      panelProps({ config: config({ blackouts: [{ from: FROM_ISO, to: TO_ISO }] }), canEdit: false }),
    );
    expect(html).toContain(escapeHtml(label("constraints.blackout.title")));
    expect(html).not.toContain(escapeHtml(label("constraints.blackout.add")));
    // Each blackout instant is a `kind="datetime-local"` DateTimeField now,
    // which renders a date <input> beside a time <select>
    // (DateTimeSplitField) rather than one <input type="datetime-local">.
    // Read-only means BOTH halves of BOTH instants stay disabled.
    const dateTags = html.match(/<input[^>]*type="date"[^>]*>/g) ?? [];
    expect(dateTags).toHaveLength(2); // from + to
    const timeSelects =
      html.match(new RegExp(`<select[^>]*aria-label="${escapeHtml(label("datetime.timeLabel"))}"[^>]*>`, "g")) ?? [];
    expect(timeSelects).toHaveLength(2);
    for (const tag of [...dateTags, ...timeSelects]) {
      // React emits `disabled=""` for true and nothing for false — the `=""` is
      // load-bearing, a bare `disabled` also matches a className.
      expect(tag).toContain('disabled=""');
    }
  });

  it("shows the upgrade gate, not a raw error, when the write is refused as unpaid", async () => {
    const { ApiV1Error } = await import("@/lib/client-v1");
    api.putRejects = () =>
      new ApiV1Error("payment required", 402, "PAYMENT_REQUIRED", {
        feature_key: "scheduling.constraints",
      });
    const island = renderIsland(ConstraintsPanel, panelProps());
    (propsOf(byText(island.tree(), "button", label("constraints.blackout.add"))!).onClick as () => void)();
    const row = () => island.tree().filter((el) => el.type === "li")[0]!;
    (propsOf(fieldsIn(row(), label("constraints.blackout.from"))[0]!).onChange as (v: string) => void)(local(FROM_ISO));
    (propsOf(fieldsIn(row(), label("constraints.blackout.to"))[0]!).onChange as (v: string) => void)(local(TO_ISO));
    (propsOf(byText(island.tree(), "button", label("constraints.blackout.save"))!).onClick as () => void)();
    await flush();

    // `usesConstraints()` on the server trips on a non-empty blackouts[]; the
    // panel must route that to the upsell it already has, keyed on the feature.
    const gate = island.tree().find((el) => propsOf(el).feature === "scheduling.constraints");
    expect(gate).toBeDefined();
  });
});

describe("blackout editor — markup and accessibility", () => {
  const rendered = () => renderPanel(panelProps({ config: config({ blackouts: [{ from: FROM_ISO, to: TO_ISO }] }) }));

  it("builds both instants with the shared DateTimeField (date input + time select)", () => {
    const html = rendered();
    const dateTags = html.match(/<input[^>]*type="date"[^>]*>/g) ?? [];
    const timeSelects =
      html.match(new RegExp(`<select[^>]*aria-label="${escapeHtml(label("datetime.timeLabel"))}"[^>]*>`, "g")) ?? [];
    expect(dateTags).toHaveLength(2);
    expect(timeSelects).toHaveLength(2);
    // The shared component's fingerprint, on BOTH halves. A hand-rolled call
    // site rendered `input w-full`; `sm:text-sm` is deliberately absent
    // (globals.css Pattern 5 already forces 16px under 40rem).
    for (const tag of [...dateTags, ...timeSelects]) {
      expect(tag).toContain('class="input w-full text-base"');
      expect(tag).not.toContain("sm:text-sm");
    }
  });

  it("names both instants with a VISIBLE label — no legend above them says it", () => {
    const html = rendered();
    for (const key of ["constraints.blackout.from", "constraints.blackout.to"] as const) {
      const text = escapeHtml(label(key));
      // The date half of the split field carries this as its VISIBLE label.
      expect(html, key).toContain(`<span class="label">${text}</span>`);
      // The time half of the SAME split field legitimately reuses this text
      // but HIDES it (it names itself distinctly via aria-label="Time"
      // instead, see DateTimeSplitField) — exactly once, not zero (the
      // whole field silently invisible) and not twice (the date half
      // silently hidden too).
      const hidden = html.match(new RegExp(`<span class="label sr-only">${text}</span>`, "g")) ?? [];
      expect(hidden, key).toHaveLength(1);
    }
  });

  it("announces both instants as required without the native attribute", () => {
    // #376: the native `required` fires the browser's own English validation
    // tooltip, which preempts the localized message this form shows instead.
    // Both halves of the split `datetime-local` field carry `required` down.
    const html = rendered();
    const dateTags = html.match(/<input[^>]*type="date"[^>]*>/g) ?? [];
    const timeSelects =
      html.match(new RegExp(`<select[^>]*aria-label="${escapeHtml(label("datetime.timeLabel"))}"[^>]*>`, "g")) ?? [];
    expect(dateTags).toHaveLength(2);
    expect(timeSelects).toHaveLength(2);
    for (const tag of [...dateTags, ...timeSelects]) {
      expect(tag).toContain('aria-required="true"');
      expect(tag).not.toMatch(/\srequired(=|\s|\/|>)/);
    }
  });

  it("keeps a stale court scope selectable so a save cannot silently rewrite it", () => {
    // Prompt 08 owns the pinned-fixture case for a removed court. An UNPINNED
    // blackout naming a gone court is inert in the engine (`courtBlocked` skips
    // it for every real court) — but if the select had no option for it, React
    // would show the first option and the next save would quietly re-scope the
    // window to the whole division.
    const html = renderPanel(
      panelProps({ config: config({ blackouts: [{ court: "Old Court", from: FROM_ISO, to: TO_ISO }] }) }),
    );
    expect(html).toContain(">Old Court</option>");
    expect(html).toContain('value="Old Court" selected=""');
  });

  it("offers the whole division and every configured court as scopes", () => {
    const html = rendered();
    expect(html).toContain(escapeHtml(label("constraints.blackout.everywhere")));
    for (const court of COURTS) expect(html).toContain(`>${court}</option>`);
  });

  it("gives the remove control a phone-sized target and a distinct name per row", () => {
    const html = renderPanel(
      panelProps({
        config: config({
          blackouts: [
            { from: FROM_ISO, to: TO_ISO },
            { from: FROM_ISO, to: TO_ISO },
          ],
        }),
      }),
    );
    for (const n of [1, 2]) {
      expect(html).toContain(`aria-label="${escapeHtml(label("constraints.blackout.remove").replace("{n}", String(n)))}"`);
    }
    // mobile.spec.ts asserts a 44px floor for anything a thumb hits; `.btn`
    // alone renders 38px.
    const removes = html.match(/<button[^>]*aria-label="Remove blackout[^"]*"[^>]*>/g) ?? [];
    expect(removes).toHaveLength(2);
    for (const tag of removes) expect(tag).toContain("min-h-11");
  });
});

describe("settings panel — the dead-end pointer is gone", () => {
  // `windowsToDailyHours` returns null when the stored windows are not a
  // uniform daily pattern, which is the only state that renders this copy.
  const boardConfig: BoardConfig = {
    startAt: "2026-08-01T09:00:00.000Z",
    endAt: null,
    matchMinutes: 30,
    gapMinutes: 0,
    courts: ["Court 1"],
    perEntrantMinRest: 0,
    blackouts: [],
    sessionWindows: [
      { from: "2026-08-01T09:00:00.000Z", to: "2026-08-01T12:00:00.000Z" },
      { from: "2026-08-02T14:00:00.000Z", to: "2026-08-02T18:00:00.000Z" },
    ],
  };

  const DICTS: [Locale, Dict, string][] = [
    ["en", enUi as Dict, "edit them there"],
    ["es", esUi as Dict, "edítalas allí"],
    ["fr", frUi as Dict, "modifiez-les là-bas"],
    ["nl", nlUi as Dict, "bewerk ze daar"],
  ];

  function renderSettings(dict: Dict, locale: Locale): string {
    return renderToStaticMarkup(
      <DictProvider dict={dict} locale={locale}>
        <StandaloneScheduleSettings
          divisionId="d1"
          config={boardConfig}
          canEdit
          constraintsAllowed
          venueCap="Court"
          orgTz={ORG_TZ}
        />
      </DictProvider>,
    );
  }

  for (const [locale, dict, oldPointer] of DICTS) {
    it(`no longer sends organisers to a panel that cannot edit windows (${locale})`, () => {
      const html = renderSettings(dict, locale);
      // The slot still renders — this state has no other explanation for why
      // the two daily-hours inputs are missing.
      expect(html).toContain(escapeHtml(dict["boardset.customWindows"] as string));
      expect(html).not.toContain(escapeHtml(oldPointer));
      expect((dict["boardset.customWindows"] as string).toLowerCase()).not.toContain(oldPointer.toLowerCase());
    });
  }

  it("still hides the daily-hours inputs while custom windows are set", () => {
    // Guards the fixture: if `windowsToDailyHours` resolved these, the copy
    // above would never render and every assertion here would be vacuous.
    // `kind="time"` no longer emits `type="time"` (it's a <select> now,
    // which would make that probe pass whether or not these fields render),
    // so the fingerprint is the fields' OWN label text instead — always
    // rendered whenever the field is, per DateTimeField's own contract.
    const html = renderSettings(enUi as Dict, "en");
    expect(html).not.toContain(escapeHtml(enUi["boardset.playFrom"] as string));
    expect(html).not.toContain(escapeHtml(enUi["boardset.playUntil"] as string));
  });
});

describe("blackout copy — translated, not copy-pasted English", () => {
  const KEYS = [
    "constraints.blackout.title",
    "constraints.blackout.hint",
    "constraints.blackout.empty",
    "constraints.blackout.add",
    "constraints.blackout.remove",
    "constraints.blackout.scope",
    "constraints.blackout.everywhere",
    "constraints.blackout.errorOrder",
    "constraints.blackout.errorIncomplete",
    "constraints.blackout.save",
  ] as const;

  for (const [locale, dict] of [
    ["es", esUi as Dict],
    ["fr", frUi as Dict],
    ["nl", nlUi as Dict],
  ] as [Locale, Dict][]) {
    it(`differs from English for every new key (${locale})`, () => {
      for (const key of KEYS) {
        expect(dict, `${locale}/${key}`).toHaveProperty(key);
        expect(dict[key], `${locale}/${key}`).not.toBe(enUi[key]);
      }
    });
  }

  it("keeps the {n} placeholder in every locale's remove label", () => {
    for (const dict of [enUi, esUi, frUi, nlUi]) {
      expect(dict["constraints.blackout.remove"]).toContain("{n}");
    }
  });
});
