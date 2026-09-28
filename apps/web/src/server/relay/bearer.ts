// server/relay/bearer.ts — the shared 401 gate of the two internal routes a Fly Machine calls (design §6.3, C21).
//
// It lives HERE, not in one route that the other imports: a route module is a Next boundary, not an export surface,
// and `import { bearerOf } from "../route"` would drag that route's whole module graph (and its `defaultDeps`) into the
// sibling's bundle for one regex.
//
// It answers ONLY "was a bearer presented". Whether the token is genuine, unexpired, for THIS session and the JOB scope
// is `verifyRelayToken`'s question (tokens.ts), asked by the usecase with the path's sid. The refusal here is the SAME
// 401 the verifier gives — same status, code and sentence — so a caller cannot tell "no header" from "bad token": a gate
// that words its reasons differently is an oracle (tokens.ts's header). relay-internal-routes.test.ts pins the two
// bodies byte-identical.
import "server-only";
import { HttpError } from "@/lib/errors";

/** The auth scheme is case-insensitive (RFC 9110 §11.1); the token is one run of non-space characters. */
const BEARER = /^bearer\s+(\S+)$/i;

export function bearerOf(req: Request): string {
  const m = BEARER.exec(req.headers.get("authorization")?.trim() ?? "");
  if (!m) throw new HttpError(401, "relay token is not valid for this session", "RELAY_TOKEN_INVALID");
  return m[1]!;
}
