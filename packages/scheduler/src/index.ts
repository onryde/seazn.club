import type { EngineLogger } from "@seazn/engine/scheduling";
import { log } from "./logger.ts";

export { placementSolver } from "./solver.ts";
// From the import-free module, NOT placement-client.ts: that one pulls in gRPC and protobuf (see index.test.ts).
export { PlacementError, type PlacementFailure } from "./placement-error.ts";
/** The pino logger the engine's scheduler used to own (D25): same name and LOG_LEVEL. */
export const schedulerLog: EngineLogger = {
  debug: (f, m) => log.debug(f, m),
  info: (f, m) => log.info(f, m),
  warn: (f, m) => log.warn(f, m),
  error: (f, m) => log.error(f, m),
};
