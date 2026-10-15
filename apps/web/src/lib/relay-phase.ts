// lib/relay-phase.ts — IMPORT-FREE on purpose (lib/__tests__/relay-phase.test.ts pins it): api-v1/schemas.ts imports
// it by relative `.ts` path, and scripts/openapi-gen.ts / scripts/gen-relay-contracts.ts load schemas.ts under bare
// `node --experimental-strip-types`, which cannot resolve `@/`. It is also the overlay page's CLIENT-SAFE reader of the
// loopback phase endpoint (R2005): a client component must never import schemas.ts, which reaches the engine's
// scheduler (review M3). The relay-job.v1 contract (docs/contracts/relay-job.v1.json) publishes every value here:
// the phase words in `$defs.heartbeat.properties.programmePhase` and `$defs.phaseReply`, the channel words in
// `phaseChannel`, and the endpoint's three constants in `$defs.phaseEndpoint` (R2007 PR B; the compositor drift-tests
// its own copies against the vendored file, C12).

/** The compositor's programme phases, as the heartbeat and the loopback endpoint send them
 *  (compositor C03 + C06; overlay templates spec 2026-10-15 §4.2). */
export const PROGRAMME_PHASES = ["waiting", "live", "frozen", "reconnecting", "final"] as const;
export type ProgrammePhaseWire = (typeof PROGRAMME_PHASES)[number];
/** Which channel the overlay page reads the phase from (spec §4.3). */
export const PHASE_CHANNELS = ["loopback", "web"] as const;
export type PhaseChannel = (typeof PHASE_CHANNELS)[number];
/** Spec §4.3: the compositor's loopback phase endpoint. Unprivileged (> 1023) and below Linux's
 *  default ephemeral range (32768–60999), so no outbound socket is ever handed this port first. */
export const RELAY_PHASE_PORT = 7419;
export const RELAY_PHASE_PATH = "/phase";
/** Spec §4.3: a long-poll is held at most this long. */
export const RELAY_PHASE_LONG_POLL_MAX_MS = 10_000;

/** Spec §4.3: the loopback endpoint's reply, `{ phase, seq }` (relay-job.v1 `$defs.phaseReply`). schemas.ts's zod twin
 *  `RelayPhaseReply` infers exactly this type (relay-contract.test.ts pins it). */
export type RelayPhaseReply = { phase: ProgrammePhaseWire; seq: number };

export function isProgrammePhase(v: unknown): v is ProgrammePhaseWire {
  return typeof v === "string" && (PROGRAMME_PHASES as readonly string[]).includes(v);
}

/** The client-safe reader of the loopback reply, with the twin's rules exactly (STRICT): an object carrying `phase` and
 *  `seq` and nothing else, a declared phase, and a whole `seq` in [0, MAX_SAFE_INTEGER]. Anything else is null, never a
 *  partial reply. relay-contract.test.ts sweeps it against the zod twin and the published bytes. */
export function parseRelayPhaseReply(v: unknown): RelayPhaseReply | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 2 || !keys.includes("phase") || !keys.includes("seq")) return null;
  const { phase, seq } = v as Record<string, unknown>;
  if (!isProgrammePhase(phase)) return null;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) return null;
  return { phase, seq };
}
