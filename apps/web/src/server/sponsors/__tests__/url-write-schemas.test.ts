// R4 S10 fix round 1, m1: a sponsor url is only ever stored as an absolute http(s) url, at every write — the v1 API's
// runtime parse (usecases/sponsors.ts `CreateSponsorInput` / `PatchSponsorInput`), its OpenAPI declaration
// (api-v1/schemas.ts `CreateSponsor` / `PatchSponsor`), and the legacy branding-blob PATCH (app/api/orgs/[id], pinned
// through the real handler in that route's own test). zod 4's `.url()` alone accepts `javascript:` and `data:`.
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
