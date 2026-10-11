// The camera-policy VOCABULARY (design §5.1), and nothing else. One definition
// shared by the server ladder (server/external-play/camera-policy.ts), the API
// schemas (server/api-v1/schemas.ts, which `openapi:gen` loads under
// --experimental-strip-types — hence relative-import-safe, no enum) and the
// division settings control (a client component, which must not import the
// server-only module). The order IS the strictness ladder: index = rank.
// The three V433 CHECKs (competitions/divisions/stages.camera_policy) carry the
// same list in SQL; online-chess-camera-schema.test.ts sweeps this list against
// the divisions column so the two cannot drift silently.
export const CAMERA_POLICIES = ["off", "optional", "required"] as const;

export type CameraPolicy = (typeof CAMERA_POLICIES)[number];
