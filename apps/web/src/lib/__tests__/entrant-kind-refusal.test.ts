// FU1 fix round 1 (m2, I1): the entrant-kind refusals said in the reader's language off their CODE and facts. Expected
// sentences come from the four dictionaries, never from the reader under test. The screens that call these readers are
// driven in components/__tests__/entrant-kind-refusal-wiring.test.tsx and v2/__tests__/entrant-kinds-settings.test.tsx.
import { describe, expect, it } from "vitest";
import { ApiV1Error } from "@/lib/client-v1";
import type { MessageKey } from "@/lib/messages";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { settingsSaveErrorText } from "../config-issue-copy";
import { divisionKindRefusalText, registrantKindRefusalText } from "../entrant-kind-refusal";

const LOCALES = [["en", en], ["es", es], ["fr", fr], ["nl", nl]] as const;
const KINDS = ["team", "individual", "pair"] as const;
type Dict = Record<string, string>;

const localOf = (dict: unknown) => (key: MessageKey, vars?: Record<string, string | number>) =>
  (dict as Dict)[key]!.replace(/\{(\w+)\}/g, (m, name: string) => (vars && name in vars ? String(vars[name]) : m));
/** The dictionary's own sentence, filled by hand, with the kind as the locale's own lower-cased word. */
const sentence = (dict: unknown, key: string, kind: string, count?: number) =>
  (dict as Dict)[key]!
    .replace(/\{kind\}/g, (dict as Dict)[`divset.entrants.kind.${kind}`]!.toLocaleLowerCase())
    .replace(/\{count\}/g, String(count));

const err = (code: string, extra: Record<string, unknown>) => new ApiV1Error("server English 'team'", 422, code, extra);

describe("the entrant-kind refusal readers", () => {
  it("empty cases first: anything that is not one of these codes WITH its facts reads as null (the caller keeps its own text)", () => {
    const local = localOf(en);
    const notOurs = [
      undefined, null, 4, "ENTRANT_KIND_NOT_ALLOWED", {}, new Error("plain"),
      err("ERROR", { kind: "team", count: 2 }),
      err("ENTRANT_KIND_NOT_ALLOWED", {}),
      err("ENTRANT_KIND_NOT_ALLOWED", { kind: "squad" }),
      err("ENTRANT_KIND_NOT_ALLOWED", { kind: 3 }),
    ];
    let checked = 0;
    for (const e of notOurs) {
      expect(registrantKindRefusalText(e, local), String(e)).toBeNull();
      checked++;
    }
    const notOursDivision = [
      undefined, null, {}, err("ERROR", { kind: "team", count: 2 }),
      err("ENTRANT_KIND_IN_USE", {}), err("ENTRANT_KIND_IN_USE", { kind: "squad" }),
      err("REGISTRATION_KIND_IN_USE", { kind: "team" }),
      err("REGISTRATION_KIND_IN_USE", { kind: "team", count: 0 }),
      err("REGISTRATION_KIND_IN_USE", { kind: "team", count: -1 }),
      err("REGISTRATION_KIND_IN_USE", { kind: "team", count: 1.5 }),
      err("REGISTRATION_KIND_IN_USE", { kind: "team", count: "2" }),
      // The door's code is not a division-save refusal, nor the other way round.
      err("ENTRANT_KIND_NOT_ALLOWED", { kind: "team" }),
    ];
    for (const e of notOursDivision) {
      expect(divisionKindRefusalText(e, local), String(e)).toBeNull();
      checked++;
    }
    expect(registrantKindRefusalText(err("ENTRANT_KIND_IN_USE", { kind: "team" }), local)).toBeNull();
    expect(checked).toBe(notOurs.length + notOursDivision.length);
  });

  it("in every locale, each code and kind reads as that locale's sentence with the kind's own word - translated, every slot filled", () => {
    let checked = 0;
    for (const [loc, dict] of LOCALES) {
      const local = localOf(dict);
      for (const kind of KINDS) {
        const cases: [string | null, string][] = [
          [registrantKindRefusalText(err("ENTRANT_KIND_NOT_ALLOWED", { kind }), local), sentence(dict, "reg.hub.registrants.kindNotAllowed", kind)],
          [divisionKindRefusalText(err("ENTRANT_KIND_IN_USE", { kind }), local), sentence(dict, "divset.err.entrantKindInUse", kind)],
          [divisionKindRefusalText(err("REGISTRATION_KIND_IN_USE", { kind, count: 1 }), local), sentence(dict, "divset.err.registrationKindInUse.one", kind, 1)],
          [divisionKindRefusalText(err("REGISTRATION_KIND_IN_USE", { kind, count: 4 }), local), sentence(dict, "divset.err.registrationKindInUse.other", kind, 4)],
        ];
        for (const [got, want] of cases) {
          expect(got, `${loc} ${kind}`).toBe(want);
          expect(got, `${loc} ${kind}: every slot filled`).not.toMatch(/\{\w+\}/);
          expect(got, `${loc} ${kind}: not the server's English`).not.toContain("'team'");
          checked++;
        }
      }
    }
    expect(checked, "4 locales x 3 kinds x 4 sentences").toBe(48);
  });

  it("the count picks its plural and is said: 1 reads the .one sentence, 2 and 12 the .other with the number", () => {
    const local = localOf(en);
    expect(divisionKindRefusalText(err("REGISTRATION_KIND_IN_USE", { kind: "team", count: 1 }), local)).toBe(
      sentence(en, "divset.err.registrationKindInUse.one", "team", 1),
    );
    for (const count of [2, 12]) {
      const got = divisionKindRefusalText(err("REGISTRATION_KIND_IN_USE", { kind: "team", count }), local);
      expect(got).toBe(sentence(en, "divset.err.registrationKindInUse.other", "team", count));
      expect(got).toContain(String(count));
    }
  });

  it("every new key is translated: present, non-empty and different from English in es, fr and nl", () => {
    const KEYS = [
      "reg.hub.registrants.kindNotAllowed",
      "divset.err.entrantKindInUse",
      "divset.err.registrationKindInUse.one",
      "divset.err.registrationKindInUse.other",
    ];
    let checked = 0;
    for (const key of KEYS)
      for (const [loc, dict] of LOCALES) {
        const v = (dict as Dict)[key];
        expect(v?.trim(), `${loc} ${key}`).toBeTruthy();
        if (loc !== "en") expect(v, `${loc} ${key} is translated`).not.toBe((en as Dict)[key]);
        checked++;
      }
    expect(checked).toBe(16);
  });

  it("the division-save reader is wired into settingsSaveErrorText (the Entrants tab, division settings, the rules strip)", () => {
    let checked = 0;
    for (const [loc, dict] of LOCALES) {
      const local = localOf(dict);
      const refused = err("REGISTRATION_KIND_IN_USE", { kind: "pair", count: 2 });
      expect(settingsSaveErrorText(refused, local, "fallback"), loc).toBe(
        sentence(dict, "divset.err.registrationKindInUse.other", "pair", 2),
      );
      expect(settingsSaveErrorText(err("ENTRANT_KIND_IN_USE", { kind: "team" }), local, "fallback"), loc).toBe(
        sentence(dict, "divset.err.entrantKindInUse", "team"),
      );
      checked++;
    }
    // The other direction: without its facts the code keeps the server's words.
    expect(settingsSaveErrorText(err("ENTRANT_KIND_IN_USE", {}), localOf(en), "fallback")).toBe("server English 'team'");
    expect(checked).toBe(4);
  });
});
