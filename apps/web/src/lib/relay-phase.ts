// lib/relay-phase.ts — IMPORT-FREE on purpose: api-v1/schemas.ts imports it by relative `.ts` path, and
// scripts/openapi-gen.ts / scripts/gen-relay-contracts.ts load schemas.ts under bare `node --experimental-strip-types`,
// which cannot resolve `@/`. The relay-job.v1 contract (docs/contracts/relay-job.v1.json) publishes every value here:
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
