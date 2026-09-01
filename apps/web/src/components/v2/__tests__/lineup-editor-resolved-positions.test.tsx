import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { resolvePositions } from "@seazn/engine/sport";
import { hockey } from "@seazn/engine/sports/hockey";
import { LineupEditor } from "@/components/v2/lineup-editor";
import { DictProvider } from "@/components/i18n/dict-provider";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import type { SideInfo, LineupSlotIn } from "@/components/v2/fixture-console";

// R7 Task B2 — the `resolvePositions` read path, asserted as the CUSTOMER
// FACT rather than as "the function was called".
//
// FIH Rule 4 lets a competition play without a goalkeeper, and the engine has
// said so since W4 (#407): `period/kernel.ts`'s `positionsFor(cfg)` drops the
// keeper group's `min` to 0 when the competition declares
// `goalkeeper: "optional"`, and `resolvePositions` is the only thing that
// invokes it. Until R7 nothing in `apps/web` called it — every page bootstrap
// read `sportModule.positions.groups` directly — AND the console's own
// `SportInfo.positionGroups` was typed `{ key, name }[]`, so `min` was thrown
// away one layer above the editor. Both halves had to land: a resolved
// catalog whose `min` nobody carries changes nothing on screen.
//
// Producer and consumer are both real here: the hockey module's own
// `positionsFor` output is folded straight into the editor that renders it.
// A hand-written catalog on both ends would prove the fixture.
const dict = uiEn as unknown as Dict;
const wrap = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale="en">
      {node}
    </DictProvider>,
  );

const MINIMUMS = 'data-testid="lineup-position-minimums"';

function slot(i: number, positionKey: string | null): LineupSlotIn {
  return {
    person_id: `00000000-0000-0000-0000-0000000000${String(i).padStart(2, "0")}`,
    full_name: `Player ${i}`,
    slot: "starting",
    position_key: positionKey,
    order_no: i,
    roles: [],
  };
}

/** Eleven named starters, `withKeeper` of them holding hockey's "GK" group. */
function hockeySide(withKeeper: boolean): SideInfo {
  const lineup = Array.from({ length: 11 }, (_, i) =>
    slot(i + 1, withKeeper && i === 0 ? "GK" : "DF"),
  );
  return {
    id: "e1",
    name: "Home",
    kind: "team",
    members: lineup.map((s) => ({
      person_id: s.person_id,
      full_name: s.full_name,
      squad_number: null,
      default_position_key: null,
      is_captain: false,
      roles: [],
    })),
    lineup,
  };
}

const cfg = (raw: unknown) => hockey.configSchema.parse(raw);

function editorFor(rawCfg: unknown, withKeeper: boolean): string {
  const catalog = resolvePositions(hockey, cfg(rawCfg));
  return wrap(
    <LineupEditor
      fixtureId="f1"
      side={hockeySide(withKeeper)}
      positionGroups={catalog.groups}
      roles={catalog.roles ?? []}
      lineupSize={catalog.lineup.size}
      canEdit={true}
      onSaved={() => {}}
    />,
  );
}

describe("LineupEditor honours the per-config position catalog (R7 B2)", () => {
  it("a competition that declares goalkeeper: \"optional\" is NOT asked for a keeper", () => {
    // The absence IS the assertion, so it is anchored on `="` — a bare
    // `data-testid` probe would pass in both states (React serialises an
    // omitted prop as "$undefined").
    expect(editorFor({ goalkeeper: "optional" }, false)).not.toContain(MINIMUMS);
  });

  it("the same keeperless sheet under the DEFAULT config still demands a goalkeeper", () => {
    const html = editorFor({}, false);
    expect(html).toContain(MINIMUMS);
    expect(html).toContain("Goalkeeper");
  });

  it("an explicit goalkeeper: \"required\" demands one too", () => {
    expect(editorFor({ goalkeeper: "required" }, false)).toContain(MINIMUMS);
  });

  it("naming a keeper satisfies the requirement (the notice is not always-on)", () => {
    expect(editorFor({}, true)).not.toContain(MINIMUMS);
  });

  it("the relaxation is the COMPETITION's, not the sport's: hockey's static catalog still declares GK min 1", () => {
    // Guards a 'fix' that simply deletes the minimum from the module.
    expect(hockey.positions.groups.find((g) => g.key === "GK")?.min).toBe(1);
    expect(
      resolvePositions(hockey, cfg({ goalkeeper: "optional" })).groups.find((g) => g.key === "GK")
        ?.min,
    ).toBe(0);
  });
});
