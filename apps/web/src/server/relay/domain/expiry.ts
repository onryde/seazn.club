// server/relay/domain/expiry.ts — PURE. TYPE ONLY at Task 2A: session.ts declares
// its `expire` command against `Expiry`, and the compiler needs the type before
// Task 2B writes this unit's body (the timers that decide which expiry is due).
// The kinds below are exactly the ones session.ts's `expire` switch handles;
// Task 2B owns the final shape and replaces this file.
export type Expiry =
  | { kind: "none" }
  | { kind: "requested_timeout" }
  | { kind: "provision_timeout" }
  | { kind: "warming_timeout" }
  | { kind: "wall_clock" }
  | { kind: "stale_beat" }
  | { kind: "grace_expired" }
  | { kind: "ending_timeout" };
