// Engine-split 1f (D31): the fold epoch a native client sends on a score write, read off the engine rather than typed. Loads under
// plain `node --experimental-strip-types` (probed).
import { foldEpochOf } from "@seazn/engine/sport";
// Shared state and helpers (pass/fail counters, check, sessions, the HTTP/DB helpers, tag): see the header of that file.
import { newSession, check, signIn, tag, type V1Res, v1, v1data } from "../harness.ts";

/**
 * Engine-split §5.6 (owner ruling 2026-10-15): the per-sport engine-epoch FLOOR OVERRIDE through a REAL server. The usecase tests
 * prove the gate in-process; nothing else boots a server with `ENGINE_EPOCH_FLOOR_OVERRIDE` set, so a lever that instrumentation.ts
 * or a standalone build never wired would pass all of them. This suite runs ALONE (SELECTABLE_SUITES) against a THIRD server that
 * ci.yml starts from the same build with the override on `generic`, one below its own epoch, and the same value in this process's
 * env (derived there from the engine's table, never typed). It is not part of main(): the main server sets no override, and a
 * full smoke on it would only prove the lever is off. The workflow greps this suite's own count line, so a run that executed
 * fewer steps cannot pass, and greps the server's log for the boot's ACTIVE line and the gate's OVERRIDDEN line.
 *
 * generic, not football: any moved sport proves the same wiring, and generic is the one a plain two-entrant league can score with
 * no lineup. A client one below the lowered floor is the control: the lever lowers the floor, it does not remove it.
 * SMOKE_ONLY=epochFloorOverride runs it alone (SELECTABLE_SUITES).
 */
const EPOCH_FLOOR_STEPS = 10;
export async function epochFloorOverrideSuite(): Promise<void> {
  let steps = 0;
  const step = (label: string, cond: boolean) => {
    check(`epoch floor override: ${label}`, cond);
    steps++;
  };
  const SPORT = "generic";
  const declared = foldEpochOf(SPORT);
  const floor = declared - 1;
  const behind = floor - 1;
  const want = `${SPORT}=${floor}`;
  step(
    `this process names the override the server booted with (${want}: one below the engine's ${SPORT} epoch ${declared}, and ${behind} is a valid client epoch)`,
    (process.env.ENGINE_EPOCH_FLOOR_OVERRIDE ?? "").trim() === want && behind >= 1,
  );

  const owner = newSession();
  await signIn(owner, `delivered+epochfloor_${tag}@resend.dev`);
  const comp = await v1(owner, "/api/v1/competitions", "POST", { ends_on: "2030-12-31", name: `Epoch Floor ${tag}`, visibility: "private" });
  const compId = v1data<{ id: string } | undefined>(comp)?.id ?? "";
  const div = await v1(owner, `/api/v1/competitions/${compId}/divisions`, "POST", {
    name: "Epoch Floor Div",
    sport_key: SPORT,
    variant_key: "score",
    config: { points: { w: 3, d: 1, l: 0 }, progressScore: false },
  });
  const divId = v1data<{ id: string } | undefined>(div)?.id ?? "";
  const ents = await v1(
    owner,
    `/api/v1/divisions/${divId}/entrants`,
    "POST",
    [1, 2].map((i) => ({ kind: "individual", display_name: `Epoch Floor ${i} ${tag}`, seed: i })),
  );
  const stage = await v1(owner, `/api/v1/divisions/${divId}/stages`, "POST", { seq: 1, kind: "league", name: "League" });
  const stageId = v1data<{ id: string } | undefined>(stage)?.id ?? "";
  const generated = await v1(owner, `/api/v1/stages/${stageId}/generate`, "POST");
  const started = await v1(owner, `/api/v1/divisions/${divId}/start`, "POST");
  const drawn = v1data<{ id: string }[] | undefined>(await v1(owner, `/api/v1/divisions/${divId}/fixtures`)) ?? [];
  const fx = drawn[0]?.id ?? "";
  step(
    `a started two-entrant ${SPORT} league is set up — ${drawn.length} fixture(s)`,
    comp.status === 201 && div.status === 201 && ents.status === 201 && stage.status < 300 && generated.status < 300 && started.status < 300 && drawn.length === 1 && fx !== "",
  );

  const lastSeq = async () => v1data<{ last_seq: number } | undefined>(await v1(owner, `/api/v1/fixtures/${fx}/state`))?.last_seq;
  const write = (seq: number | undefined, type: string, payload: unknown, engine_epoch?: number) =>
    v1(owner, `/api/v1/fixtures/${fx}/events`, "POST", { expected_seq: seq, type, payload, ...(engine_epoch === undefined ? {} : { engine_epoch }) });
  const refusedAt = (r: V1Res, got: number) => {
    // The 426 body carries { sport, required, got } beside the code (api-v1/http.ts spreads the HttpError's extra); V1Res types only the common fields.
    const e: { code?: string; sport?: string; required?: number; got?: number } | undefined = r.json.error;
    // `required` is the EFFECTIVE (lowered) floor: what the client must reach, not the engine's own epoch.
    return r.status === 426 && e?.code === "ENGINE_OUTDATED" && e.sport === SPORT && e.required === floor && e.got === got;
  };

  // The control first: one below the LOWERED floor is still refused, and the refusal writes nothing.
  step(`a client at epoch ${behind} (below the lowered floor ${floor}) is refused 426 ENGINE_OUTDATED, required ${floor}`, refusedAt(await write(0, "core.start", {}, behind), behind));
  step("the refusal wrote nothing (last_seq is still 0)", (await lastSeq()) === 0);
  // The lever: at the lowered floor, below the engine's own epoch - the real table would refuse this.
  const atFloor = await write(0, "core.start", {}, floor);
  step(`a client at epoch ${floor} (the lowered floor, below the engine's ${declared}) is ADMITTED: 201, seq 1`, atFloor.status === 201 && v1data<{ seq: number }>(atFloor).seq === 1);
  const second = await write(1, "core.note", { text: "second call" }, floor);
  step("a second call at the lowered floor is admitted too: 201, seq 2", second.status === 201 && v1data<{ seq: number }>(second).seq === 2);
  const atOwn = await write(2, "core.note", { text: "at the engine's epoch" }, declared);
  step(`a client at the engine's own epoch ${declared} still needs no lever: 201, seq 3`, atOwn.status === 201 && v1data<{ seq: number }>(atOwn).seq === 3);
  const absent = await write(3, "core.note", { text: "no epoch at all" });
  step("a request with no engine_epoch (the web pad) is unaffected: 201, seq 4", absent.status === 201 && v1data<{ seq: number }>(absent).seq === 4);
  step(`the control still holds after the admitted writes: epoch ${behind} is refused again`, refusedAt(await write(4, "core.note", { text: "behind" }, behind), behind));
  step("the ledger holds exactly the four admitted events (last_seq 4)", (await lastSeq()) === 4);
  check(`epoch floor override: all ${EPOCH_FLOOR_STEPS} steps ran (ran ${steps})`, steps === EPOCH_FLOOR_STEPS);
}
