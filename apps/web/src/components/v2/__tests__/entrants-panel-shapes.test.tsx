import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  NewEntrantFields,
  RosterEditor,
  EntrantsPanel,
  eligibilityBadges,
  type EntrantsPanelEligibility,
} from "@/components/v2/entrants-panel";
import type { EffectiveEntrantModel, EntrantKind } from "@seazn/engine/sport";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

const testMsg = (key: string, vars?: Record<string, string | number>) => t(uiEn, key, vars);

// Same harness as stages-panel-delete.test.tsx: mock the router + confirm hooks
// and assert on the STATIC markup. RosterEditor + NewEntrantFields are rendered
// in isolation, so only their own imports need stubbing.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const PERSONS = [
  { id: "p1", full_name: "Alice", dob: null, gender: null },
  { id: "p2", full_name: "Bob", dob: null, gender: null },
  { id: "p3", full_name: "Carol", dob: null, gender: null },
];

function member(id: string, name: string, extra: { dob?: string | null; gender?: string | null } = {}) {
  return {
    person_id: id,
    full_name: name,
    dob: extra.dob ?? null,
    gender: extra.gender ?? null,
    squad_number: null,
    default_position_key: null,
    is_captain: false,
    roles: [],
  };
}

const NO_ELIGIBILITY: EntrantsPanelEligibility = {
  category: null,
  age_min: null,
  age_max: null,
  eligibility_note: null,
};

function model(kind: EntrantKind): EffectiveEntrantModel {
  return {
    kinds: ["individual", "pair", "team"],
    defaultKind: kind,
    squadNumbers: true,
    captain: true,
    maxTeamMembers: null,
  };
}

function renderRoster(opts: {
  kind: string;
  members: ReturnType<typeof member>[];
  allowCaptain: boolean;
  allowSquadNumbers: boolean;
  eligibility?: EntrantsPanelEligibility;
}) {
  return renderToStaticMarkup(
    <RosterEditor
      kind={opts.kind}
      members={opts.members}
      persons={PERSONS}
      positionGroups={[]}
      roles={[]}
      canEdit={true}
      busy={false}
      allowCaptain={opts.allowCaptain}
      allowSquadNumbers={opts.allowSquadNumbers}
      entrantModel={model(opts.kind as EntrantKind)}
      eligibility={opts.eligibility ?? NO_ELIGIBILITY}
      conflictsFor={() => []}
      onSave={() => {}}
    />,
  );
}

function renderAddForm(m: { kinds: EntrantKind[]; defaultKind: EntrantKind }) {
  const em: EffectiveEntrantModel = {
    kinds: m.kinds,
    defaultKind: m.defaultKind,
    squadNumbers: true,
    captain: true,
    maxTeamMembers: null,
  };
  return renderToStaticMarkup(
    <NewEntrantFields
      persons={PERSONS}
      busy={false}
      onSubmit={async () => undefined}
      entrantModel={em}
    />,
  );
}

describe("RosterEditor — kind/model-aware roster", () => {
  it("individual roster: no captain, no squad number, no picker at cap", () => {
    const html = renderRoster({
      kind: "individual",
      members: [member("p1", "Alice")],
      allowCaptain: true,
      allowSquadNumbers: true,
    });
    expect(html).not.toContain("captain");
    expect(html).not.toContain('placeholder="No."');
    expect(html).not.toContain(testMsg("entrants.roster.findPlayer"));
  });

  it("team roster with captain disabled by config hides the checkbox", () => {
    const html = renderRoster({
      kind: "team",
      members: [member("p1", "Alice")],
      allowCaptain: false,
      allowSquadNumbers: false,
    });
    expect(html).not.toContain("captain");
    expect(html).toContain(testMsg("entrants.roster.findPlayer"));
  });

  it("pair picker caps at 2 — a full pair hides the add picker but keeps Save reachable", () => {
    // Regression: the add-row and Save button used to be ONE block gated on
    // `!atCap`, so a pair sitting at its 2/2 cap (the ordinary steady state,
    // not just mid-edit) lost the Save button entirely — there was no way
    // off the screen except discarding whatever edit got it there.
    const html = renderRoster({
      kind: "pair",
      members: [member("p1", "Alice"), member("p2", "Bob")],
      allowCaptain: false,
      allowSquadNumbers: false,
    });
    expect(html).not.toContain(testMsg("entrants.roster.findPlayer"));
    expect(html).toContain(testMsg("entrants.roster.save"));
  });

  it("individual at cap (1/1) also keeps Save reachable", () => {
    const html = renderRoster({
      kind: "individual",
      members: [member("p1", "Alice")],
      allowCaptain: true,
      allowSquadNumbers: true,
    });
    expect(html).not.toContain(testMsg("entrants.roster.findPlayer"));
    expect(html).toContain(testMsg("entrants.roster.save"));
  });
});

// RS011 — organiser-side eligibility gates: MISSING_DOB/MISSING_GENDER are
// advisory (amber), never a block, and only worth showing when the
// DIVISION's own rules actually need the field — requiresDob/requiresGender
// (@/lib/registration-rules), the SAME predicates the server-side gate
// evaluates against, not a second rule invented for display.
describe("RosterEditor — MISSING_DOB/MISSING_GENDER amber chips (RS011)", () => {
  const AGE_BAND: EntrantsPanelEligibility = { ...NO_ELIGIBILITY, age_min: 10, age_max: 18 };
  const MENS: EntrantsPanelEligibility = { ...NO_ELIGIBILITY, category: "mens" };

  it("a division with an age band chips a member with no dob", () => {
    const html = renderRoster({
      kind: "individual",
      members: [member("p1", "Alice")],
      allowCaptain: false,
      allowSquadNumbers: false,
      eligibility: AGE_BAND,
    });
    expect(html).toContain(testMsg("divset.entrants.warning.missingDob"));
  });

  it("the SAME division does not chip a member who already has a dob", () => {
    const html = renderRoster({
      kind: "individual",
      members: [member("p1", "Alice", { dob: "2010-01-01" })],
      allowCaptain: false,
      allowSquadNumbers: false,
      eligibility: AGE_BAND,
    });
    expect(html).not.toContain(testMsg("divset.entrants.warning.missingDob"));
  });

  it("a division with NO age band never chips a missing dob — nothing to be missing FOR", () => {
    const html = renderRoster({
      kind: "individual",
      members: [member("p1", "Alice")],
      allowCaptain: false,
      allowSquadNumbers: false,
      eligibility: NO_ELIGIBILITY,
    });
    expect(html).not.toContain(testMsg("divset.entrants.warning.missingDob"));
  });

  it("a mens/womens/mixed division chips a member with no gender", () => {
    const html = renderRoster({
      kind: "individual",
      members: [member("p1", "Alice")],
      allowCaptain: false,
      allowSquadNumbers: false,
      eligibility: MENS,
    });
    expect(html).toContain(testMsg("divset.entrants.warning.missingGender"));
  });

  it("the SAME division does not chip a member who already has a gender", () => {
    const html = renderRoster({
      kind: "individual",
      members: [member("p1", "Alice", { gender: "m" })],
      allowCaptain: false,
      allowSquadNumbers: false,
      eligibility: MENS,
    });
    expect(html).not.toContain(testMsg("divset.entrants.warning.missingGender"));
  });
});

// RS007/V380 — the entrants tab's eligibility badge used to read a
// permanently-`[]` prop ("UI-half, a separate wave" — [divSlug]/page.tsx's
// own comment), which killed the badge for EVERY division, including ones
// with a real category/age band. It now reads the real `divisions` columns
// (category/age_min/age_max/eligibility_note) instead of the retired jsonb
// `eligibility` array.
describe("eligibilityBadges — real columns, not the retired jsonb rules", () => {
  const NONE: EntrantsPanelEligibility = {
    category: null,
    age_min: null,
    age_max: null,
    eligibility_note: null,
  };

  it("no restriction at all -> no badges", () => {
    expect(eligibilityBadges(NONE, testMsg)).toEqual([]);
  });

  it("category 'open' is the SAME as null -> still no category badge (matches the hub row's own precedent)", () => {
    expect(eligibilityBadges({ ...NONE, category: "open" }, testMsg)).toEqual([]);
  });

  it("mens/womens/mixed each produce a category badge, reusing the hub row's own vocabulary", () => {
    expect(eligibilityBadges({ ...NONE, category: "mens" }, testMsg)).toEqual([testMsg("reg.hub.row.category.mens")]);
    expect(eligibilityBadges({ ...NONE, category: "womens" }, testMsg)).toEqual([
      testMsg("reg.hub.row.category.womens"),
    ]);
    expect(eligibilityBadges({ ...NONE, category: "mixed" }, testMsg)).toEqual([
      testMsg("reg.hub.row.category.mixed"),
    ]);
  });

  it("an age RANGE (both min and max) produces one range badge", () => {
    expect(eligibilityBadges({ ...NONE, age_min: 10, age_max: 18 }, testMsg)).toEqual([
      testMsg("reg.hub.row.ageBand.range", { min: 10, max: 18 }),
    ]);
  });

  it("age_max alone (the wizard's own 'age group' shape) produces a max-only badge", () => {
    expect(eligibilityBadges({ ...NONE, age_max: 15 }, testMsg)).toEqual([
      testMsg("reg.hub.row.ageBand.max", { max: 15 }),
    ]);
  });

  it("age_min alone produces a min-only badge", () => {
    expect(eligibilityBadges({ ...NONE, age_min: 35 }, testMsg)).toEqual([
      testMsg("reg.hub.row.ageBand.min", { min: 35 }),
    ]);
  });

  it("the note renders VERBATIM — organiser-authored text, never a translated label", () => {
    expect(eligibilityBadges({ ...NONE, eligibility_note: "School-registered students only" }, testMsg)).toEqual([
      "School-registered students only",
    ]);
  });

  it("category, age band and note all combine, in that order", () => {
    const badges = eligibilityBadges(
      {
        category: "womens",
        age_min: null,
        age_max: 15,
        eligibility_note: "School-registered students only",
      },
      testMsg,
    );
    expect(badges).toEqual([
      testMsg("reg.hub.row.category.womens"),
      testMsg("reg.hub.row.ageBand.max", { max: 15 }),
      "School-registered students only",
    ]);
  });
});

vi.mock("@/lib/entrant-badge", () => ({ resolveEntrantBadge: () => null }));

// The full component render — proves the badge is actually WIRED INTO the
// JSX, not just that the pure derivation function above is correct in
// isolation (the exact class of bug the "[]" prop shipped: a correct
// column, never rendered).
describe("EntrantsPanel — the eligibility prop actually reaches the badge", () => {
  const BASE_PROPS = {
    divisionId: "div-1",
    entrants: [],
    canEdit: true,
    positionGroups: [],
    roles: [],
    entrantModel: {
      kinds: ["individual", "pair", "team"] as EntrantKind[],
      defaultKind: "individual" as EntrantKind,
      squadNumbers: true,
      captain: true,
      maxTeamMembers: null,
    } satisfies EffectiveEntrantModel,
    viewerPlan: "community" as const,
    divisionStatus: "setup",
  };

  it("renders category + age + note badges from a real eligibility prop", () => {
    // category: "mixed" (not "mens"/"womens") — renderToStaticMarkup HTML-
    // escapes apostrophes in text content ("Men's" -> "Men&#x27;s"), which
    // a plain .toContain() against the raw translated string cannot see
    // through. eligibilityBadges' own unit tests above already cover mens/
    // womens directly against the string, with no HTML serialisation in the
    // way; this test's job is only to prove the wiring reaches the JSX.
    const html = renderToStaticMarkup(
      <EntrantsPanel
        {...BASE_PROPS}
        eligibility={{
          category: "mixed",
          age_min: null,
          age_max: 15,
          eligibility_note: "School-registered students only",
        }}
      />,
    );
    expect(html).toContain(testMsg("reg.hub.row.category.mixed"));
    expect(html).toContain(testMsg("reg.hub.row.ageBand.max", { max: 15 }));
    expect(html).toContain("School-registered students only");
  });

  it("renders no eligibility banner at all when the division has no restriction", () => {
    const html = renderToStaticMarkup(
      <EntrantsPanel
        {...BASE_PROPS}
        eligibility={{ category: null, age_min: null, age_max: null, eligibility_note: null }}
      />,
    );
    expect(html).not.toContain(testMsg("divset.entrants.eligibility.label"));
  });
});

describe("NewEntrantFields — kind/model-aware add form", () => {
  it("single allowed kind hides the select; individual keeps a name field (name-only entrants stay possible)", () => {
    const html = renderAddForm({ kinds: ["individual"], defaultKind: "individual" });
    expect(html).not.toContain(">Kind<");
    // The journeys regression (e2e serial): organisers register name-only
    // entrants without person records — the field must stay, auto-filled
    // when a person IS picked.
    expect(html).toContain(">Name<");
    expect(html).toContain('placeholder="Alex Doe"');
    expect(html).toContain("Search players…");
  });

  it("single allowed kind renders a static caption for that kind", () => {
    const html = renderAddForm({ kinds: ["individual"], defaultKind: "individual" });
    expect(html).toContain("Individual");
  });

  it("multiple kinds render the kind chip group", () => {
    const html = renderAddForm({
      kinds: ["individual", "pair", "team"],
      defaultKind: "team",
    });
    expect(html).toContain(">Kind<");
    // team default keeps the manual name field
    expect(html).toContain(">Name<");
  });
});
