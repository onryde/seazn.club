// R4 S10 fix round 1, m1: a sponsor url is only ever stored as an absolute http(s) url, at every write — the v1 API's
// runtime parse (usecases/sponsors.ts `CreateSponsorInput` / `PatchSponsorInput`) and its OpenAPI declaration
// (api-v1/schemas.ts `CreateSponsor` / `PatchSponsor`). The legacy branding-blob PATCH that also took a url went in R4 fix
// batch 3, and the board now links every sponsor through the tracked `/s/` redirect (`sponsorHref`), so these schemas,
// with the route's own refusal behind them, keep a non-http(s) url off every public page. zod 4's `.url()` alone accepts
// `javascript:` and `data:`.
//
// Expected values come from the rule (http and https only), never from `redirectTarget`, the predicate under test.
import { describe, expect, it } from "vitest";
import { CreateSponsor, PatchSponsor } from "@/server/api-v1/schemas";
import { CreateSponsorInput, PatchSponsorInput } from "@/server/usecases/sponsors";

const REFUSED = [
  "javascript:alert(document.cookie)",
  "JavaScript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "ftp://files.example/brochure.pdf",
  "vbscript:msgbox(1)",
  "mailto:hello@sponsor.example",
  "file:///etc/passwd",
];
const ACCEPTED = ["https://sponsor.example/", "http://sponsor.example/offer?x=1", "HTTPS://Sponsor.Example/Deal"];

const SCHEMAS = [
  ["usecase CreateSponsorInput (the v1 runtime parse)", CreateSponsorInput],
  ["usecase PatchSponsorInput (the v1 runtime parse)", PatchSponsorInput],
  ["api-v1 CreateSponsor (OpenAPI)", CreateSponsor],
  ["api-v1 PatchSponsor (OpenAPI)", PatchSponsor],
] as const;

describe("sponsor url writes: http(s) only (m1)", () => {
  it("every write schema refuses every non-http(s) scheme, on the `url` field (count reported)", () => {
    let checked = 0;
    for (const [name, schema] of SCHEMAS) {
      for (const url of REFUSED) {
        const res = schema.safeParse({ name: "Acme", url });
        expect(res.success, `${name}: ${url}`).toBe(false);
        expect(res.error!.issues.map((i) => i.path.join(".")), `${name}: ${url}`).toContain("url");
        checked++;
      }
    }
    expect(checked).toBe(SCHEMAS.length * REFUSED.length);
  });

  it("positive pair: http and https save, and so does no url at all (count reported)", () => {
    let checked = 0;
    for (const [name, schema] of SCHEMAS) {
      for (const url of [...ACCEPTED, null, undefined]) {
        expect(schema.safeParse({ name: "Acme", url }).success, `${name}: ${String(url)}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(SCHEMAS.length * (ACCEPTED.length + 2));
  });
});

// Final review 2, m5: each PATCH is its create's `patchOf` twin (lib/zod-patch.ts) plus the PATCH-only `on_stream` - one field
// list per file, never a second hand-rolled one beside it. The expected key list is the CREATE schema's own (its declaration
// is the authority), and every field is probed both ways: omitted stays omitted on the patch (the default is the create's
// alone), and each create field's accepted and refused values are the patch's too.
describe("m5: each sponsor PATCH is its create's patchOf twin, plus on_stream", () => {
  const PAIRS = [
    ["api-v1 (OpenAPI)", CreateSponsor, PatchSponsor],
    ["usecase (the v1 runtime parse)", CreateSponsorInput, PatchSponsorInput],
  ] as const;
  /** One value each field must accept, and one it must refuse, from the field's rule (the tier and status sets, a uuid). */
  const PROBES: Record<string, { ok: unknown; bad: unknown }> = {
    name: { ok: "Acme", bad: "" },
    url: { ok: "https://sponsor.example/", bad: "javascript:alert(1)" },
    logo_path: { ok: "logos/acme.png", bad: "x".repeat(501) },
    tier: { ok: "gold", bad: "platinum" },
    competition_id: { ok: "6f1c2b9e-1d2a-4c3b-9e8f-7a6b5c4d3e2f", bad: "not-a-uuid" },
    status: { ok: "pending", bad: "archived" },
  };

  it("the same keys in the same order, then on_stream; an omitted field stays omitted; the create keeps its defaults (count reported)", () => {
    let checked = 0;
    for (const [name, create, patch] of PAIRS) {
      const keys = Object.keys(create.shape);
      expect(keys.length, `${name}: anti-vacuity`).toBeGreaterThan(0);
      expect(Object.keys(patch.shape), name).toEqual([...keys, "on_stream"]);
      expect(patch.parse({}), `${name}: nothing omitted is filled`).toEqual({});
      expect(create.parse({ name: "Acme" }), `${name}: the create's own defaults`).toMatchObject({ tier: "partner", status: "active" });
      checked++;
    }
    expect(checked).toBe(PAIRS.length);
  });

  it("every create field accepts and refuses on the patch exactly as on the create; on_stream is a boolean on the patch only (count reported)", () => {
    let checked = 0;
    for (const [name, create, patch] of PAIRS) {
      expect(Object.keys(PROBES).sort(), `${name}: a probe for every create field`).toEqual(Object.keys(create.shape).sort());
      for (const [field, { ok, bad }] of Object.entries(PROBES)) {
        for (const value of [ok, bad]) {
          const onCreate = create.safeParse({ name: "Acme", [field]: value }).success;
          expect(patch.safeParse({ [field]: value }).success, `${name}.${field} = ${JSON.stringify(value).slice(0, 30)}`).toBe(onCreate);
          checked++;
        }
        expect(create.safeParse({ name: "Acme", [field]: ok }).success, `${name}.${field}: the probe's accepted value`).toBe(true);
        expect(create.safeParse({ name: "Acme", [field]: bad }).success, `${name}.${field}: the probe's refused value`).toBe(false);
      }
      expect(patch.safeParse({ on_stream: true }).success, `${name}: on_stream`).toBe(true);
      expect(patch.safeParse({ on_stream: "yes" }).success, `${name}: on_stream is a boolean`).toBe(false);
      expect("on_stream" in create.shape, `${name}: on_stream is PATCH-only`).toBe(false);
    }
    expect(checked).toBe(PAIRS.length * Object.keys(PROBES).length * 2);
  });
});
