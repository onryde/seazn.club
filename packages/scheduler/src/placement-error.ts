// The placement client's failure vocabulary, in its own module with NO imports: `index.ts` re-exports it, and a static
// re-export from `placement-client.ts` would load gRPC and protobuf the first time anything imports `@seazn/scheduler`
// (the engine it came from loaded its client lazily). `placement-client.ts` re-exports it too, so there is one class
// however it is imported, and `instanceof PlacementError` holds for every error the client throws.

/**
 * Why a solve did not produce an outcome, in domain words. `build.ts` decides
 * whether to fall back on this field; it must never need `grpc.status`, which
 * is exactly the vocabulary this type exists to stop at the boundary.
 */
export type PlacementFailure =
  | "invalid_request" // refused here, or refused by the service's own ACL
  | "deadline" // no answer inside wallSeconds + the margin
  | "unauthenticated" // the shared secret was rejected
  | "unavailable" // the service could not be reached
  | "transport"; // anything else that went wrong on the wire

export class PlacementError extends Error {
  readonly failure: PlacementFailure;

  constructor(failure: PlacementFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PlacementError";
    this.failure = failure;
  }
}
