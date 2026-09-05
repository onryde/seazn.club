// P9 scope item 5 — the court multi-picker that replaces the free-text court
// list in schedule setup. Copy-free component (see file header on
// court-multi-picker.tsx), so every test below passes plain literal strings
// as props — no DictProvider needed, unlike most v2 component suites.
//
// apps/web is vitest `environment: "node"` with no jsdom (see
// venues-panel.tsx's own test-strategy comment), so interaction (a click
// actually firing onChange) is NOT testable here — the pure helpers
// (toggleCourtSelection/reorderSelection/courtGroups/flattenCourts) carry
// that logic and are tested directly; renderToStaticMarkup only proves what
// HTML a given `value`/`venues` prop produces.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Court, Venue } from "@/components/v2/venues-panel";
import {
  CourtMultiPicker,
  type CourtMultiPickerProps,
  courtGroups,
  courtOptionsFor,
  flattenCourts,
  reorderSelection,
  resolveCourtNames,
  toggleCourtSelection,
} from "../court-multi-picker";

function makeCourt(overrides: Partial<Court> = {}): Court {
  return {
    id: "c-1",
    venue_id: "v-1",
    name: "Court 1",
    sort: 0,
    tags: [],
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    hours: [],
    exceptions: [],
    ...overrides,
  };
}

function makeVenue(overrides: Partial<Venue> = {}): Venue {
  return {
    id: "v-1",
    name: "Main Venue",
    address: null,
    sort: 0,
    archived_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    courts: [],
    ...overrides,
  };
}

const baseProps: Omit<CourtMultiPickerProps, "venues" | "value" | "onChange"> = {
  label: "Courts",
  description: "Pick the courts this schedule can use.",
  emptyTitle: "No courts yet",
  emptyBody: "Add a venue and a court, then come back.",
  directoryLinkLabel: "Go to Directory",
  selectedLabel: "Selected",
  noneSelectedLabel: "No courts selected yet.",
  unknownCourtLabel: "Unknown court",
  moveUpLabel: "Move up",
  moveDownLabel: "Move down",
  removeLabelFor: (n) => `Remove court ${n}`,
};

describe("toggleCourtSelection", () => {
  it("appends a newly-checked court to the END of the order", () => {
    expect(toggleCourtSelection(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("removes an unchecked court and closes the gap, keeping the rest in order", () => {
    expect(toggleCourtSelection(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("refuses to add past the max cap", () => {
    expect(toggleCourtSelection(["a"], "b", 1)).toEqual(["a"]);
  });

  it("still allows removing an already-selected court AT the cap", () => {
    expect(toggleCourtSelection(["a"], "a", 1)).toEqual([]);
  });
});

describe("reorderSelection", () => {
  it("moves an entry up, swapping with its neighbour", () => {
    expect(reorderSelection(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
  });

  it("moves an entry down, swapping with its neighbour", () => {
    expect(reorderSelection(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
  });

  it("is a no-op moving the first entry further up", () => {
    expect(reorderSelection(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
  });

  it("is a no-op moving the last entry further down", () => {
    expect(reorderSelection(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
  });
});

// Competition Desk W2, ruling R35 — per-fixture court assignment returns to the
// fixtures tab, INSIDE the inline editor the time cell opens. The option list
// it renders is the logic worth pinning; the `<select>` itself is a DOM control
// this node-environment suite cannot exercise (file header above).
//
// It is `courtGroups` plus ONE case that a multi-select never has: a fixture
// already sitting on an ARCHIVED court. `courtGroups` correctly refuses to
// OFFER such a court — you cannot newly pick one — but a single-select whose
// `value` matches no `<option>` silently displays the FIRST option instead, so
// the row would read "Unassigned" for a fixture that has a court. The current
// court is therefore carried as an extra, clearly-labelled option.
describe("courtOptionsFor — the per-fixture single-select's options", () => {
  const active = makeCourt({ id: "c-1", name: "Court 1" });
  const archived = makeCourt({ id: "c-9", name: "Old Court", archived_at: "2026-01-01T00:00:00.000Z" });
  const venues = [makeVenue({ id: "v-1", courts: [active, archived] })];

  it("with nothing assigned it is exactly courtGroups, and no orphan", () => {
    expect(courtOptionsFor(venues, null, null)).toEqual({ groups: courtGroups(venues), current: null });
  });

  it("an assigned ACTIVE court needs no extra option — it is already offered", () => {
    expect(courtOptionsFor(venues, "c-1", "Court 1").current).toBeNull();
  });

  // The witness. Without this, the select shows "Unassigned" on a fixture that
  // is in fact on a court, which is the "two contradicting facts in one row"
  // class this whole wave exists to remove.
  it("an assigned ARCHIVED court is carried as its own option", () => {
    const { groups, current } = courtOptionsFor(venues, "c-9", "Old Court");
    expect(current).toEqual({ id: "c-9", name: "Old Court" });
    // ...and it is NOT smuggled into the selectable groups: it must stay
    // un-pickable for any OTHER fixture.
    expect(groups.flatMap((g) => g.courts.map((c) => c.id))).toEqual(["c-1"]);
  });

  it("falls back to the id when the archived court has no resolved name", () => {
    expect(courtOptionsFor(venues, "c-9", null).current).toEqual({ id: "c-9", name: "c-9" });
  });

  it("a court id that resolves nowhere at all is still carried", () => {
    // A court deleted outright, or one belonging to another org's venue the
    // caller never loaded. Dropping it here would silently clear the fixture's
    // court on the next save.
    expect(courtOptionsFor(venues, "c-gone", "Ghost").current).toEqual({ id: "c-gone", name: "Ghost" });
  });
});

describe("courtGroups", () => {
  it("drops archived courts but keeps the venue's other active courts", () => {
    const venues = [
      makeVenue({
        id: "v-1",
        courts: [
          makeCourt({ id: "c-1", name: "Active", archived_at: null }),
          makeCourt({ id: "c-2", name: "Retired", archived_at: "2026-01-01T00:00:00.000Z" }),
        ],
      }),
    ];
    expect(courtGroups(venues)).toEqual([{ venue: venues[0], courts: [venues[0]!.courts[0]] }]);
  });

  it("drops an entirely archived venue", () => {
    const venues = [makeVenue({ id: "v-1", archived_at: "2026-01-01T00:00:00.000Z", courts: [makeCourt()] })];
    expect(courtGroups(venues)).toEqual([]);
  });

  it("drops an active venue left with zero courts after archived-filtering", () => {
    const venues = [makeVenue({ id: "v-1", courts: [makeCourt({ archived_at: "2026-01-01T00:00:00.000Z" })] })];
    expect(courtGroups(venues)).toEqual([]);
  });

  it("preserves the server's own order — never re-sorts by id", () => {
    // Deliberately id-descending / non-alphabetical input order.
    const venues = [
      makeVenue({ id: "v-9", name: "Z Venue", courts: [makeCourt({ id: "c-9", name: "Zeta" })] }),
      makeVenue({ id: "v-1", name: "A Venue", courts: [makeCourt({ id: "c-1", name: "Alpha" })] }),
    ];
    expect(courtGroups(venues).map((g) => g.venue.id)).toEqual(["v-9", "v-1"]);
  });
});

describe("flattenCourts", () => {
  it("concatenates every group's courts in courtGroups order", () => {
    const venues = [
      makeVenue({ id: "v-1", courts: [makeCourt({ id: "c-1" }), makeCourt({ id: "c-2" })] }),
      makeVenue({ id: "v-2", courts: [makeCourt({ id: "c-3" })] }),
    ];
    expect(flattenCourts(venues).map((c) => c.id)).toEqual(["c-1", "c-2", "c-3"]);
  });
});

describe("resolveCourtNames (P9 pass 4d — item 2)", () => {
  it("venue-qualifies a bare name shared by courts in different venues", () => {
    // The owner's live bug: a division's board showed three columns —
    // "TENNIS COURT 1", "TENNIS COURT 3", "TENNIS COURT 3" — because two
    // DIFFERENT venues each have a court literally named "Tennis Court 3"
    // (P8's uniqueness is per-venue: `unique (venue_id, name) where
    // archived_at is null`, so this is legal data).
    const venues = [
      makeVenue({
        id: "v-north",
        name: "North Sports Centre",
        courts: [makeCourt({ id: "c-north-3", name: "Tennis Court 3" })],
      }),
      makeVenue({
        id: "v-south",
        name: "South Leisure Park",
        courts: [makeCourt({ id: "c-south-3", name: "Tennis Court 3" })],
      }),
    ];
    const names = resolveCourtNames(venues);
    expect(names["c-north-3"]).toBe("Tennis Court 3 (North Sports Centre)");
    expect(names["c-south-3"]).toBe("Tennis Court 3 (South Leisure Park)");
    // The two labels must actually differ — two board columns must never
    // render the identical text for two different courts.
    expect(names["c-north-3"]).not.toBe(names["c-south-3"]);
  });

  it("leaves a uniquely-named court bare — no gratuitous venue suffix", () => {
    const venues = [
      makeVenue({
        id: "v-north",
        name: "North Sports Centre",
        courts: [
          makeCourt({ id: "c-north-3", name: "Tennis Court 3" }),
          makeCourt({ id: "c-north-showcase", name: "Centre Court" }),
        ],
      }),
      makeVenue({
        id: "v-south",
        name: "South Leisure Park",
        courts: [makeCourt({ id: "c-south-3", name: "Tennis Court 3" })],
      }),
    ];
    const names = resolveCourtNames(venues);
    // Ambiguous name -> qualified; unique name -> bare, even though OTHER
    // courts in the same input needed a suffix.
    expect(names["c-north-3"]).toBe("Tennis Court 3 (North Sports Centre)");
    expect(names["c-north-showcase"]).toBe("Centre Court");
  });

  it("includes archived courts and venues in the map, folding them into the SAME ambiguity check as active courts (review finding #6)", () => {
    // The old code built its rows from `courtGroups`, which drops archived
    // venues/courts BEFORE the directory ever sees them. That defeated the
    // schedule page's `listVenues(auth, { includeArchived: true })` fetch —
    // a fixture placed before its court was archived had no name to render
    // at all (BoardGrid's column header fell back to the bare uuid).
    const venues = [
      makeVenue({
        id: "v-north",
        name: "North Sports Centre",
        courts: [makeCourt({ id: "c-north-3", name: "Tennis Court 3" })],
      }),
      makeVenue({
        id: "v-south",
        name: "South Leisure Park",
        courts: [
          makeCourt({
            id: "c-south-3-retired",
            name: "Tennis Court 3",
            archived_at: "2026-01-01T00:00:00.000Z",
          }),
        ],
      }),
    ];
    const names = resolveCourtNames(venues);
    // The archived court now resolves to a real name — it is not dropped —
    // and because it shares a bare name with the active court in a
    // different venue, BOTH get venue-qualified, exactly as two ACTIVE
    // courts sharing a name would. Two different courts must never render
    // as identical text just because one of them happens to be archived.
    expect(names["c-south-3-retired"]).toBe("Tennis Court 3 (South Leisure Park)");
    expect(names["c-north-3"]).toBe("Tennis Court 3 (North Sports Centre)");
    expect(names["c-north-3"]).not.toBe(names["c-south-3-retired"]);
  });

  it("resolves an archived court's name for display while keeping it OUT of the selectable option list", () => {
    // The second half is what stops the first from being a blanket
    // widening: only the NAME map grows to cover archived courts — the
    // checkbox options an organiser can newly pick must not.
    const venues = [
      makeVenue({
        id: "v-1",
        name: "Main Venue",
        courts: [
          makeCourt({ id: "c-1", name: "Center Court", archived_at: null }),
          makeCourt({ id: "c-2", name: "Retired Court", archived_at: "2026-01-01T00:00:00.000Z" }),
        ],
      }),
    ];
    expect(resolveCourtNames(venues)["c-2"]).toBe("Retired Court");

    const html = renderToStaticMarkup(
      <CourtMultiPicker {...baseProps} venues={venues} value={[]} onChange={() => {}} />,
    );
    expect(html).not.toContain("Retired Court");
    expect(html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []).toHaveLength(1);
  });
});

describe("CourtMultiPicker — render", () => {
  it("renders the Directory pointer, not an empty control, when the org has no courts", () => {
    const html = renderToStaticMarkup(<CourtMultiPicker {...baseProps} venues={[]} value={[]} onChange={() => {}} />);
    expect(html).toContain('href="/directory?tab=venues"');
    expect(html).toContain("No courts yet");
    expect(html).not.toContain('type="checkbox"');
  });

  it("hides an archived court from the option list while keeping its active sibling", () => {
    const venues = [
      makeVenue({
        courts: [
          makeCourt({ id: "c-1", name: "Center Court", archived_at: null }),
          makeCourt({ id: "c-2", name: "Retired Court", archived_at: "2026-01-01T00:00:00.000Z" }),
        ],
      }),
    ];
    const html = renderToStaticMarkup(
      <CourtMultiPicker {...baseProps} venues={venues} value={[]} onChange={() => {}} />,
    );
    expect(html).toContain("Center Court");
    expect(html).not.toContain("Retired Court");
  });

  it("shows the selection in the organiser's chosen order, not id/list order", () => {
    const venues = [
      makeVenue({ courts: [makeCourt({ id: "c-1", name: "Alpha" }), makeCourt({ id: "c-2", name: "Beta" })] }),
    ];
    // Chosen order is Beta THEN Alpha — the reverse of the courts array.
    const html = renderToStaticMarkup(
      <CourtMultiPicker {...baseProps} venues={venues} value={["c-2", "c-1"]} onChange={() => {}} />,
    );
    const betaIndex = html.indexOf("Beta");
    const alphaIndex = html.indexOf("Alpha");
    expect(betaIndex).toBeGreaterThan(-1);
    expect(betaIndex).toBeLessThan(alphaIndex);
  });

  it("keeps an existing selection visible when every venue is archived", () => {
    // Review wave 2. `courtGroups` drops archived venues, so a division whose
    // courts were configured and whose venue was later archived rendered the
    // "no courts yet" empty state and NOTHING else — while `config.courts`
    // still held those ids and the solver still scheduled on them. The
    // organiser could neither see nor remove them.
    const venues = [
      makeVenue({
        id: "v-gone",
        name: "Closed Hall",
        archived_at: "2026-01-01T00:00:00.000Z",
        courts: [makeCourt({ id: "c-gone", name: "Court 1" })],
      }),
    ];
    const html = renderToStaticMarkup(
      <CourtMultiPicker {...baseProps} venues={venues} value={["c-gone"]} onChange={() => {}} />,
    );
    // The selection is still shown, by NAME (the name map is archived
    // inclusive on purpose — finding #6), so it can be removed.
    expect(html).toContain("Court 1");
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    // …and this is NOT the empty state.
    expect(html).not.toContain(baseProps.emptyTitle);

    // The contrast: with nothing selected, the empty state is still correct.
    const empty = renderToStaticMarkup(
      <CourtMultiPicker {...baseProps} venues={venues} value={[]} onChange={() => {}} />,
    );
    expect(empty).toContain(baseProps.emptyTitle);
  });

  it("venue-qualifies the selected-order strip when two selected courts share a bare name across venues (review finding #13)", () => {
    // Two courts literally named "Court 1" in different venues are legal
    // data (courts' uniqueness is per-venue — see the resolveCourtNames
    // suite above). The venue-grouped checkbox list below can lean on its
    // venue heading, but this flat, unheaded order strip has no such
    // heading — it must qualify the text itself or the two are
    // indistinguishable.
    const venues = [
      makeVenue({
        id: "v-north",
        name: "North Sports Centre",
        courts: [makeCourt({ id: "c-north-1", name: "Court 1" })],
      }),
      makeVenue({
        id: "v-south",
        name: "South Leisure Park",
        courts: [makeCourt({ id: "c-south-1", name: "Court 1" })],
      }),
    ];
    const html = renderToStaticMarkup(
      <CourtMultiPicker
        {...baseProps}
        venues={venues}
        value={["c-north-1", "c-south-1"]}
        onChange={() => {}}
      />,
    );
    // The strip renders the venue on its OWN line rather than inside the
    // label, so that a 320px viewport truncates the two independently — a
    // single "Court 1 (North Sports Centre)" span clips to "Court 1 (North…"
    // and two venues sharing a prefix become identical text again. Scoped to
    // the <ol> deliberately: both venue names also appear as the checkbox
    // list's group headings, so an unscoped `toContain` would pass even with
    // the strip's qualification removed entirely.
    const strip = /<ol[^>]*>([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? "";
    expect(strip).not.toBe("");
    expect(strip).toContain("North Sports Centre");
    expect(strip).toContain("South Leisure Park");
    // And the two entries are genuinely distinguishable from one another.
    expect(strip.indexOf("North Sports Centre")).not.toBe(strip.indexOf("South Leisure Park"));
  });

  it("falls back to the unknown-court label for a selected id with no matching court", () => {
    const venues = [makeVenue({ courts: [makeCourt({ id: "c-1", name: "Alpha" })] })];
    const html = renderToStaticMarkup(
      <CourtMultiPicker {...baseProps} venues={venues} value={["stale-id"]} onChange={() => {}} />,
    );
    expect(html).toContain("Unknown court");
  });

  it("disables an unchecked court once maxSelected is reached, but leaves the checked one enabled", () => {
    const venues = [
      makeVenue({ courts: [makeCourt({ id: "c-1", name: "Alpha" }), makeCourt({ id: "c-2", name: "Beta" })] }),
    ];
    const html = renderToStaticMarkup(
      <CourtMultiPicker {...baseProps} venues={venues} value={["c-1"]} onChange={() => {}} maxSelected={1} />,
    );
    const inputs = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).not.toContain("disabled");
    expect(inputs[1]).toContain("disabled");
  });

  it("renders each court's tags beside its name", () => {
    const venues = [makeVenue({ courts: [makeCourt({ id: "c-1", name: "Clay 1", tags: ["clay", "indoor"] })] })];
    const html = renderToStaticMarkup(
      <CourtMultiPicker {...baseProps} venues={venues} value={[]} onChange={() => {}} />,
    );
    expect(html).toContain("clay");
    expect(html).toContain("indoor");
  });
});
