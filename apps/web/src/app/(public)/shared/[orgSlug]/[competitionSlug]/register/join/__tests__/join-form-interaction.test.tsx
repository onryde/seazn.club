// RS007 — interaction test for the join page's client island (join-form.tsx
// <-> its reused StepWho/StepConsent). Mounts the REAL JoinForm via
// _hook-harness.tsx's renderIsland (no jsdom in this workspace) and drives
// it the way a browser would — the same deepExpand pattern
// register-stepper-interaction.test.tsx established for expanding opaque
// nested step components in one pass.
//
// useT() throws outside a <DictProvider> under the harness (DictContext's
// default is null) — mocked to the REAL English runtime translator, not an
// identity stub, so assertions read actual copy.
const apiV1Mock = vi.hoisted(() => ({
  calls: [] as { url: string; method?: string; json?: unknown }[],
  queue: [] as ({ ok: true; data: unknown } | { ok: false; error: unknown })[],
}));
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      apiV1Mock.calls.push({ url, method: options?.method, json: options?.json });
      const next = apiV1Mock.queue.shift();
      if (!next) return Promise.resolve(undefined);
      return next.ok ? Promise.resolve(next.data) : Promise.reject(next.error);
    },
  };
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import type { ReactElement, ReactNode } from "react";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { ApiV1Error } from "@/lib/client-v1";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { StepConsent } from "@/components/public-site/register/step-consent";
import { StepWho } from "@/components/public-site/register/step-who";
import { JoinForm, type JoinFormProps } from "../join-form";

const EN_UI: Dict = JSON.parse(
  readFileSync(
    pathJoin(__dirname, "..", "..", "..", "..", "..", "..", "..", "..", "dictionaries", "en", "ui.json"),
    "utf8",
  ),
) as Dict;

vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(EN_UI, key, vars),
}));

type ComponentFn = (props: Record<string, unknown>) => ReactNode;
const OPAQUE: ComponentFn[] = [StepWho, StepConsent] as unknown as ComponentFn[];

/** Same growing-worklist expansion register-stepper-interaction.test.tsx
 *  uses — JoinForm nests exactly these two opaque (hookless besides the
 *  mocked useT) step components. */
function deepExpand(node: ReactNode): ReactElement[] {
  const out = walk(node);
  for (let i = 0; i < out.length; i++) {
    const type = out[i]!.type;
    if (typeof type === "function" && OPAQUE.includes(type as ComponentFn)) {
      out.push(...walk((type as ComponentFn)(propsOf(out[i]!))));
    }
  }
  return out;
}

const JOIN_CODE = "SECRET-JOIN-CODE-777";

const BASE_PROPS: JoinFormProps = {
  orgSlug: "riverside",
  competitionSlug: "summer-smash",
  joinCode: JOIN_CODE,
  displayName: "Team Alpha",
  orgName: "Riverside CC",
  unclaimedSlots: [
    { player_id: "p1", full_name: "Sam Player" },
    { player_id: "p2", full_name: "Jordan Player" },
  ],
  allowNewPlayer: true,
  requiresDob: false,
  requiresGender: false,
  totalPlayers: 3,
  initialPlayerId: null,
};

function mount(props: Partial<JoinFormProps> = {}) {
  const island = renderIsland(JoinForm, { ...BASE_PROPS, ...props }, deepExpand);

  const radios = () => island.tree().filter((e) => e.type === "input" && propsOf(e).type === "radio");
  const clickByText = (text: string) => {
    const btn = island.tree().find((e) => e.type === "button" && textOf(e).includes(text));
    expect(btn, `no button with text "${text}"`).toBeTruthy();
    (propsOf(btn!).onClick as () => void | Promise<void>)();
  };
  const fieldByLabel = (id: string) => island.tree().find((e) => propsOf(e).id === id);
  const pageText = () => textOf(island.tree());

  return { island, radios, clickByText, fieldByLabel, pageText };
}

beforeEach(() => {
  apiV1Mock.calls = [];
  apiV1Mock.queue = [];
});

// ---------------------------------------------------------------------------
// Slot picker
// ---------------------------------------------------------------------------

describe("slot picker", () => {
  it("lists every unclaimed slot by name, plus 'I'm someone else' when allowed", () => {
    const { pageText } = mount();
    expect(pageText()).toContain("Sam Player");
    expect(pageText()).toContain("Jordan Player");
    expect(pageText()).toContain("I'm someone else");
  });

  it("hides 'I'm someone else' for a pair (allowNewPlayer: false) — one slot, no add-new option", () => {
    const { pageText, radios } = mount({
      unclaimedSlots: [{ player_id: "partner", full_name: "Sam Partner" }],
      allowNewPlayer: false,
    });
    expect(pageText()).not.toContain("I'm someone else");
    expect(radios()).toHaveLength(1);
  });

  it("a per-slot link pre-selects that slot's radio, and the joiner can still change it", () => {
    const { radios } = mount({ initialPlayerId: "p2" });
    const [p1Radio, p2Radio] = radios();
    expect(propsOf(p2Radio!).checked).toBe(true);
    expect(propsOf(p1Radio!).checked).toBe(false);

    // Still changeable — picking p1 flips the selection.
    (propsOf(p1Radio!).onChange as () => void)();
    const after = radios();
    expect(propsOf(after[0]!).checked).toBe(true);
    expect(propsOf(after[1]!).checked).toBe(false);
  });

  it("blocks submit and shows 'choose which one is you' when nothing is selected", async () => {
    const { pageText, island } = mount(); // 2 slots + add-new -> genuinely ambiguous, nothing pre-picked
    await (propsOf(island.tree().find((e) => e.type === "button" && textOf(e).includes("Confirm my spot"))!)
      .onClick as () => Promise<void>)();
    expect(pageText()).toContain("Choose which one is you");
    expect(apiV1Mock.calls, "must not have posted with no selection").toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// StepWho reuse — no "I'm registering myself" toggle on the join page
// ---------------------------------------------------------------------------

describe("StepWho reuse (showSelfToggle=false) — the join page never asks 'I'm playing'", () => {
  it("renders name/email fields but never the self-toggle checkbox", () => {
    const { pageText, island } = mount();
    expect(pageText()).toContain("Your name");
    expect(pageText()).toContain("Email");
    expect(pageText()).not.toContain("I'm registering myself");
    const checkboxes = island.tree().filter((e) => e.type === "input" && propsOf(e).type === "checkbox");
    // Privacy + media consent checkboxes only (2) — no self-toggle checkbox.
    expect(checkboxes).toHaveLength(2);
  });

  it("dob/gender fields render only when the division actually requires them", () => {
    const bare = mount({ requiresDob: false, requiresGender: false });
    expect(bare.fieldByLabel("reg-who-dob")).toBeUndefined();
    expect(bare.fieldByLabel("reg-who-gender")).toBeUndefined();

    const needsBoth = mount({ requiresDob: true, requiresGender: true });
    expect(needsBoth.fieldByLabel("reg-who-dob")).toBeTruthy();
    expect(needsBoth.fieldByLabel("reg-who-gender")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Consent reuse — names-public copy + roster notice suppressed for a joiner
// ---------------------------------------------------------------------------

describe("StepConsent reuse", () => {
  it("states the names-public default plainly, same as the main register flow's consent step", () => {
    const { pageText } = mount();
    expect(pageText()).toContain("By default, your name appears publicly on this event's pages.");
  });

  it("never shows the captain-facing roster notice — a joiner names nobody but themselves", () => {
    const { pageText } = mount();
    expect(pageText()).not.toContain("You're entering other people in this registration.");
  });
});

// ---------------------------------------------------------------------------
// Minor joiner -> guardian path
// ---------------------------------------------------------------------------

describe("minor joiner — guardian path", () => {
  function fillWho(island: ReturnType<typeof mount>, dob: string) {
    const nameInput = island.island.tree().find((e) => propsOf(e).id === "reg-who-name")!;
    (propsOf(nameInput).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Kid Joiner" } });
    const emailInput = island.island.tree().find((e) => propsOf(e).id === "reg-who-email")!;
    (propsOf(emailInput).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "kid@example.com" },
    });
    const dobInput = island.island.tree().find((e) => propsOf(e).id === "reg-who-dob")!;
    (propsOf(dobInput).onChange as (e: { target: { value: string } }) => void)({ target: { value: dob } });
  }

  it("shows the guardian block once a minor dob is entered, and blocks submit without it", async () => {
    const m = mount({ requiresDob: true, initialPlayerId: "p1" });
    expect(m.pageText()).not.toContain("Under-18 entry");
    fillWho(m, "2015-01-01");
    expect(m.pageText()).toContain("Under-18 entry");

    await (propsOf(m.island.tree().find((e) => e.type === "button" && textOf(e).includes("Confirm my spot"))!)
      .onClick as () => Promise<void>)();
    expect(m.pageText()).toContain("Enter the guardian's name");
    expect(apiV1Mock.calls).toHaveLength(0);
  });

  it("sends guardian_name/guardian_consent in the POST body once supplied — never the join_code anywhere but its own field", async () => {
    apiV1Mock.queue.push({ ok: true, data: { registration_id: "reg-1", player_id: "p1", consent_status: "guardian" } });
    const m = mount({ requiresDob: true, initialPlayerId: "p1" });
    fillWho(m, "2015-01-01");

    const guardianNameInput = m.island.tree().find((e) => propsOf(e).id === "reg-guardian-name")!;
    (propsOf(guardianNameInput).onChange as (e: { target: { value: string } }) => void)({
      target: { value: "A Guardian" },
    });
    const guardianConsentBox = m.island.tree().find((e) => propsOf(e).id === "reg-guardian-consent")!;
    (propsOf(guardianConsentBox).onChange as (e: { target: { checked: boolean } }) => void)({
      target: { checked: true },
    });
    const privacyBox = m.island.tree().find((e) => propsOf(e).id === "reg-consent-privacy")!;
    (propsOf(privacyBox).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });

    await (propsOf(m.island.tree().find((e) => e.type === "button" && textOf(e).includes("Confirm my spot"))!)
      .onClick as () => Promise<void>)();

    expect(apiV1Mock.calls).toHaveLength(1);
    const call = apiV1Mock.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.json).toMatchObject({
      join_code: JOIN_CODE,
      player_id: "p1",
      guardian_name: "A Guardian",
      guardian_consent: true,
    });
    expect(JSON.stringify(call.json ?? {}).match(new RegExp(JOIN_CODE, "g"))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Consent wiring — RS007 review defect #4 (HIGH): the join page hard-blocks
// submit on privacy consent, but the POST body sent neither privacy_consent
// nor media_consent — a joiner's privacy consent was never recorded, and a
// deliberate media-consent REFUSAL was silently overridden by the captain's
// own group-level choice (joinTeamEntry now persists both PER-PLAYER, never
// on the group — registration-submit.ts).
// ---------------------------------------------------------------------------

describe("consent wiring — RS007 defect #4", () => {
  it("sends privacy_consent/media_consent once both are ticked", async () => {
    apiV1Mock.queue.push({ ok: true, data: { registration_id: "reg-1", player_id: "p1", consent_status: "granted" } });
    const m = mount({ initialPlayerId: "p1" });
    fillMinimalValidForm(m); // ticks privacy only
    const mediaBox = m.island.tree().find((e) => propsOf(e).id === "reg-consent-media")!;
    (propsOf(mediaBox).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    await submit(m);
    expect(apiV1Mock.calls[0]!.json).toMatchObject({ privacy_consent: true, media_consent: true });
  });

  it("a deliberate media-consent REFUSAL is sent as `false`, not omitted — must never be silently overridden server-side", async () => {
    apiV1Mock.queue.push({ ok: true, data: { registration_id: "reg-1", player_id: "p1", consent_status: "granted" } });
    const m = mount({ initialPlayerId: "p1" });
    fillMinimalValidForm(m); // ticks privacy only — media stays unchecked
    await submit(m);
    const body = apiV1Mock.calls[0]!.json as Record<string, unknown>;
    expect(body.privacy_consent).toBe(true);
    expect("media_consent" in body).toBe(true);
    expect(body.media_consent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Submit outcomes — designed states, never a raw server string
// ---------------------------------------------------------------------------

function fillMinimalValidForm(m: ReturnType<typeof mount>) {
  const nameInput = m.island.tree().find((e) => propsOf(e).id === "reg-who-name")!;
  (propsOf(nameInput).onChange as (e: { target: { value: string } }) => void)({ target: { value: "Alex Joiner" } });
  const emailInput = m.island.tree().find((e) => propsOf(e).id === "reg-who-email")!;
  (propsOf(emailInput).onChange as (e: { target: { value: string } }) => void)({
    target: { value: "alex@example.com" },
  });
  const privacyBox = m.island.tree().find((e) => propsOf(e).id === "reg-consent-privacy")!;
  (propsOf(privacyBox).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
}

async function submit(m: ReturnType<typeof mount>) {
  const btn = m.island.tree().find((e) => e.type === "button" && textOf(e).includes("Confirm my spot"))!;
  await (propsOf(btn).onClick as () => Promise<void>)();
}

describe("submit — success", () => {
  it("a CLAIM shows the success state with the fill meter unchanged in total, claimed +1", async () => {
    apiV1Mock.queue.push({ ok: true, data: { registration_id: "reg-1", player_id: "p1", consent_status: "granted" } });
    const m = mount({ initialPlayerId: "p1", totalPlayers: 4, unclaimedSlots: [
      { player_id: "p1", full_name: "Sam Player" },
      { player_id: "p2", full_name: "Jordan Player" },
    ] });
    fillMinimalValidForm(m);
    await submit(m);
    expect(m.pageText()).toContain("You're in");
    // totalPlayers 4, 2 unclaimed before -> 2 already granted; claiming ONE
    // more (p1) makes 3, total stays 4.
    // RS007 #20: roster-side copy renamed off "confirm" (register.status.
    // roster.meter) — it shares this key with the status page's own meter,
    // so it can no longer be misread as a payment state.
    expect(m.pageText()).toContain("3 of 4 checked in");
    expect(m.pageText()).toContain("Team Alpha");
  });

  it("an INSERT ('I'm someone else') grows the total in the fill meter too", async () => {
    apiV1Mock.queue.push({ ok: true, data: { registration_id: "reg-1", player_id: "new-1", consent_status: "granted" } });
    const m = mount({ unclaimedSlots: [], allowNewPlayer: true, totalPlayers: 3 });
    const newRadio = m.radios()[0]!;
    (propsOf(newRadio).onChange as () => void)();
    fillMinimalValidForm(m);
    await submit(m);
    expect(m.pageText()).toContain("4 of 4 checked in");
  });

  it("does not send a player_id at all for the insert path", async () => {
    apiV1Mock.queue.push({ ok: true, data: { registration_id: "reg-1", player_id: "new-1", consent_status: "granted" } });
    const m = mount({ unclaimedSlots: [], allowNewPlayer: true });
    const newRadio = m.radios()[0]!;
    (propsOf(newRadio).onChange as () => void)();
    fillMinimalValidForm(m);
    await submit(m);
    const body = apiV1Mock.calls[0]!.json as Record<string, unknown>;
    expect("player_id" in body).toBe(false);
  });
});

describe("submit — designed failure states, never a raw server string", () => {
  it("409 (already claimed) shows the designed conflict state with a refresh action, not the server's own message", async () => {
    apiV1Mock.queue.push({
      ok: false,
      error: new ApiV1Error("This player has already joined", 409, "CONFLICT"),
    });
    const m = mount({ initialPlayerId: "p1" });
    fillMinimalValidForm(m);
    await submit(m);
    expect(m.pageText()).toContain("Someone already claimed that spot");
    expect(m.pageText()).not.toContain("This player has already joined");
    expect(m.pageText()).toContain("Refresh available spots");
  });

  it("refreshing after a conflict re-fetches the preview and updates the picker", async () => {
    apiV1Mock.queue.push({ ok: false, error: new ApiV1Error("already joined", 409, "CONFLICT") });
    apiV1Mock.queue.push({
      ok: true,
      data: { unclaimed_slots: [{ player_id: "p2", full_name: "Jordan Player" }], allow_new_player: true },
    });
    const m = mount({ initialPlayerId: "p1" });
    fillMinimalValidForm(m);
    await submit(m);
    m.clickByText("Refresh available spots");
    // Let the refresh promise resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(m.pageText()).not.toContain("Sam Player");
    expect(m.pageText()).toContain("Jordan Player");
    expect(apiV1Mock.calls[1]!.url).toContain("join_code=" + JOIN_CODE);
    expect(apiV1Mock.calls[1]!.method ?? undefined).not.toBe("POST");
  });

  // Bug (2026-08-27 review, FIX 4): NEW_PLAYER_CHOICE ("new") is never a
  // real player_id, so refreshSlots's old "does the selection still exist
  // in the fresh unclaimed list" check silently reset a valid "I'm someone
  // else" pick to null on every refresh — even though the fresh preview
  // still allowed a new player, forcing the joiner to re-pick and risk the
  // exact same conflict again.
  it("a conflict refresh preserves a valid 'I'm someone else' selection instead of silently dropping it", async () => {
    apiV1Mock.queue.push({ ok: false, error: new ApiV1Error("already joined", 409, "CONFLICT") });
    apiV1Mock.queue.push({
      ok: true,
      data: { unclaimed_slots: [{ player_id: "p2", full_name: "Jordan Player" }], allow_new_player: true },
    });
    const m = mount({
      unclaimedSlots: [{ player_id: "p1", full_name: "Sam Player" }],
      allowNewPlayer: true,
      initialPlayerId: null,
    });
    const newRadioBefore = m.radios()[m.radios().length - 1]!;
    (propsOf(newRadioBefore).onChange as () => void)();
    fillMinimalValidForm(m);
    await submit(m);
    m.clickByText("Refresh available spots");
    await Promise.resolve();
    await Promise.resolve();
    const after = m.radios();
    const newRadioAfter = after[after.length - 1]!;
    expect(propsOf(newRadioAfter).checked, "the 'I'm someone else' selection must survive the refresh").toBe(true);
  });

  it("404 (a stale/dead code or player_id) shows the SAME 'not valid' copy as the page-level invalid-link state", async () => {
    apiV1Mock.queue.push({ ok: false, error: new ApiV1Error("This join link is not valid", 404, "NOT_FOUND") });
    const m = mount({ initialPlayerId: "p1" });
    fillMinimalValidForm(m);
    await submit(m);
    expect(m.pageText()).toContain("expired");
    expect(m.pageText()).not.toContain("This join link is not valid");
  });

  // RS007 review defect #15 (MEDIUM): 429 used to fall through to
  // classifyJoinFailure's catch-all "rejected", whose copy is scoped to
  // roster cap/eligibility — a throttled teammate was told their DETAILS
  // were refused, not that they'd tried too many times.
  it("429 (throttled) shows a distinct 'too many attempts' state, never the 'couldn't complete this' copy", async () => {
    apiV1Mock.queue.push({ ok: false, error: new ApiV1Error("Too many requests — slow down and try again.", 429, "RATE_LIMITED") });
    const m = mount({ initialPlayerId: "p1" });
    fillMinimalValidForm(m);
    await submit(m);
    expect(m.pageText()).toContain("You've tried this a few times in a row");
    expect(m.pageText()).not.toContain("We couldn't complete this");
  });

  it("422 (e.g. roster cap, pair-can't-add, ineligible) shows a designed 'couldn't complete this' state", async () => {
    apiV1Mock.queue.push({ ok: false, error: new ApiV1Error("This roster is already full", 422, "ERROR") });
    const m = mount({ initialPlayerId: "p1" });
    fillMinimalValidForm(m);
    await submit(m);
    expect(m.pageText()).toContain("We couldn't complete this");
    expect(m.pageText()).not.toContain("This roster is already full");
  });

  it("5xx / network failure shows the generic retry copy", async () => {
    apiV1Mock.queue.push({ ok: false, error: new ApiV1Error("boom", 503, "INTERNAL") });
    const m = mount({ initialPlayerId: "p1" });
    fillMinimalValidForm(m);
    await submit(m);
    expect(m.pageText()).toContain("Something went wrong — please try again.");
  });

  it("CRITICAL: the join_code capability token never appears in ANY rendered failure banner", async () => {
    for (const status of [404, 409, 422, 429, 503]) {
      apiV1Mock.queue = [{ ok: false, error: new ApiV1Error("server detail", status, "X") }];
      const m = mount({ initialPlayerId: "p1" });
      fillMinimalValidForm(m);
      await submit(m);
      expect(m.pageText(), `status ${status} leaked the join_code`).not.toContain(JOIN_CODE);
    }
  });
});
