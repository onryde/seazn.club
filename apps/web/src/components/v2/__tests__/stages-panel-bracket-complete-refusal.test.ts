// W4 app-A Task 6 (AN-2): the organiser's Complete on a bracket with a line still owed a result is refused 409
// STAGE_HAS_UNDECIDED_FIXTURES. The stage list says it through `classifyActError`; a knockout code used to fall through
// to `seedingErrorMessage`, which knows only SEEDING_* codes and painted the server's English sentence. Now it is the
// dictionary's sentence, amber (matches to finish, nothing broken), in every locale.
import { describe, expect, it } from "vitest";
import { classifyActError } from "@/components/v2/stages-panel";
import { ApiV1Error } from "@/lib/client-v1";
import { msg } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

/** The plan's code and key (Task 6), typed here. */
const CODE = "STAGE_HAS_UNDECIDED_FIXTURES";
const KEY = "knockout.refusal.STAGE_HAS_UNDECIDED_FIXTURES";
const SERVER = "server: STAGE_HAS_UNDECIDED_FIXTURES in English";
const DICTS = { en, es, fr, nl } as unknown as Record<string, Record<string, string>>;

describe("classifyActError — Complete refused on a bracket still owed a result", () => {
  it("is amber, says the dictionary's sentence, and needs no refresh", () => {
    const out = classifyActError(new ApiV1Error(SERVER, 409, CODE, { fixture_ids: ["f3"] }), msg, "en");
    expect(out).toEqual({ tone: "warning", text: DICTS.en![KEY], refresh: false });
    expect(out.text).not.toBe(SERVER);
  });

  it("in the reader's language: each locale's own sentence, never the English", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries(DICTS)) {
      const local = dict[KEY];
      expect(typeof local === "string" && local.trim() !== "", `${locale}/${KEY} is missing`).toBe(true);
      if (locale !== "en") expect(local, `${locale} copies the English`).not.toBe(DICTS.en![KEY]);
      const bound: typeof msg = (key, vars) => msgFor(locale as never, key, vars);
      const out = classifyActError(new ApiV1Error(SERVER, 409, CODE), bound, locale as never);
      expect(out.text, locale).toBe(local);
      checked++;
    }
    expect(checked, "anti-vacuity: four locales").toBe(4);
  });

  it("an unknown 409 still falls through to the generic path (the negative pair)", () => {
    const out = classifyActError(new ApiV1Error("busy", 409, "SOMETHING_ELSE"), msg, "en");
    expect(out.tone).toBe("error");
    expect(out.text).not.toBe(DICTS.en![KEY]);
  });
});

// B3 fix round 1 (review #6): a knockout refusal whose sentence names something (`{stage}`) takes the value from the
// error envelope's fields — the server sends it beside the code (`knockoutRefusal(code, details)`, which `apiV1` hands
// over as `err.extra`). Rendering the key bare painted a literal "{stage}" to the organiser.
describe("classifyActError — a knockout refusal with a placeholder fills it from the envelope", () => {
  const FED_CODE = "KO_LATE_ENTRY_FED_STAGE";
  const FED_KEY = "knockout.refusal.KO_LATE_ENTRY_FED_STAGE";
  const FED_SERVER = "This knockout is filled from Groups. Add the player there.";

  it("names the feeding stage in each locale's own sentence, never a bare placeholder", () => {
    let checked = 0;
    for (const [locale, dict] of Object.entries(DICTS)) {
      const local = dict[FED_KEY];
      expect(typeof local === "string" && local.includes("{stage}"), `${locale}/${FED_KEY} names {stage}`).toBe(true);
      const bound: typeof msg = (key, vars) => msgFor(locale as never, key, vars);
      const out = classifyActError(new ApiV1Error(FED_SERVER, 422, FED_CODE, { stage: "Groups" }), bound, locale as never);
      expect(out, locale).toEqual({ tone: "warning", text: local!.replace("{stage}", "Groups"), refresh: false });
      expect(out.text, locale).not.toContain("{");
      checked++;
    }
    expect(checked, "anti-vacuity: four locales").toBe(4);
  });

  it("an envelope field that is no string or number fills nothing (the sentence's own placeholder never becomes [object Object])", () => {
    const out = classifyActError(new ApiV1Error(FED_SERVER, 422, FED_CODE, { stage: { id: "s1" } }), msg, "en");
    expect(out.text).not.toContain("[object");
  });
});
