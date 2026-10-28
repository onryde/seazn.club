// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { type Session, raw, check, tag, v1, v1data } from "../harness.ts";

/** v8 (spec 2026-07-13): the format is editable until a stage that inherits it
 *  starts (W2c owner P-2), then PATCH rejects with DIVISION_FORMAT_LOCKED naming
 *  that stage; the stage structure PUT still locks once fixtures exist
 *  (FORMAT_LOCKED); the logo upload URL mints for editors. SMOKE_ONLY=divisionSettings
 *  runs it alone (SELECTABLE_SUITES). */
export async function divisionSettingsSuite(admin: Session): Promise<void> {
  const comp = v1data<{ id: string; slug: string }>(
    await v1(admin, "/api/v1/competitions", "POST", { ends_on: "2030-12-31",
      name: `V8 Probe ${tag}`,
    }),
  );
  const div = v1data<{ id: string }>(
    await v1(admin, `/api/v1/competitions/${comp.id}/divisions`, "POST", {
      name: "Lockable",
      sport_key: "generic",
      variant_key: "score",
      config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
    }),
  );

  const pre = await raw(admin, `/api/v1/divisions/${div.id}`, "PATCH", {
    config: { points: { w: 2, d: 1, l: 0 }, progressScore: false },
  });
  check("v8 format editable pre-fixtures", pre.status === 200);

  const uploadUrl = await raw(admin, `/api/v1/divisions/${div.id}/logo-upload-url`, "POST", {});
  const upload = uploadUrl.json.data as { storage_path?: string } | undefined;
  check(
    "v8 division logo upload URL mints (or 503 keyless)",
    (uploadUrl.status === 200 && !!upload?.storage_path?.includes(div.id)) ||
      // CI smoke runs without Supabase creds — the guard is the behavior.
      (uploadUrl.status === 503 &&
        (uploadUrl.json.error as { message?: string } | undefined)?.message ===
          "Storage is not configured"),
  );

  await v1(admin, `/api/v1/divisions/${div.id}/entrants`, "POST", [
    { kind: "individual", display_name: "A", seed: 1 },
    { kind: "individual", display_name: "B", seed: 2 },
  ]);
  const stage = v1data<{ id: string }>(
    await v1(admin, `/api/v1/divisions/${div.id}/stages`, "POST", {
      seq: 1,
      kind: "league",
      name: "L",
      config: {},
    }),
  );
  const firstFixtureId = v1data<{ fixtures: { id: string }[] }>(
    await v1(admin, `/api/v1/stages/${stage.id}/generate`, "POST"),
  ).fixtures[0].id;

  // W2c owner P-2 (X-SR-4): the variant locks per STARTED stage that inherits it, not once fixtures exist. Each PATCH
  // sends a DIFFERENT variant from the stored one: re-sending the stored variant is a 200 no-op since W2c Task 2, so it
  // could not tell a lock from a no-op. Generic declares both `score` and `win_loss`.
  const early = await raw(admin, `/api/v1/divisions/${div.id}`, "PATCH", { variant_key: "win_loss" });
  check("v8 format: a variant change is accepted while no stage has started (P-2)", early.status === 200);
  await v1(admin, `/api/v1/divisions/${div.id}/start`, "POST"); // scoring before the start is 422 WRONG_PHASE
  const started = await v1(admin, `/api/v1/fixtures/${firstFixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  const post = await raw(admin, `/api/v1/divisions/${div.id}`, "PATCH", { variant_key: "score" });
  check(
    "v8 format 409s once an inheriting stage has started (P-2)",
    started.status === 201 &&
      post.status === 409 &&
      (post.json.error as { code?: string } | undefined)?.code === "DIVISION_FORMAT_LOCKED" &&
      JSON.stringify(post.json).includes('"L"'), // names the started stage
  );

  const structSwap = await raw(admin, `/api/v1/divisions/${div.id}/stages`, "PUT", [
    { seq: 1, kind: "knockout", name: "KO", config: {}, progression: null },
  ]);
  check(
    "v8 structure PUT 409s once fixtures exist",
    structSwap.status === 409 &&
      (structSwap.json.error as { code?: string } | undefined)?.code === "FORMAT_LOCKED",
  );
}
