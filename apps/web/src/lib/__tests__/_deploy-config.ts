// What a fly deploy config declares about its environment, read from the file (not typed into a test): the app name each ends in
// (`seazn-club-prod`, `seazn-club-stg`) says which environment it is, and NEXT_PUBLIC_BASE_URL is the origin it bakes into the
// client bundle. Tests take their expected environment from here, so a renamed app or a moved domain moves the test with it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

export interface DeployConfig {
  app: string;
  baseUrl: string;
  environment: "production" | "staging";
}

export function deployConfig(file: "fly.toml" | "fly.stg.toml"): DeployConfig {
  const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
  const app = /^app\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  const baseUrl = /^\s*NEXT_PUBLIC_BASE_URL\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  expect(app, `${file} declares an app`).toBeTruthy();
  expect(baseUrl, `${file} bakes a NEXT_PUBLIC_BASE_URL`).toBeTruthy();
  const environment = app!.endsWith("-prod") ? "production" : app!.endsWith("-stg") ? "staging" : undefined;
  expect(environment, `${file}: the app name (${app}) ends in -prod or -stg`).toBeDefined();
  return { app: app!, baseUrl: baseUrl!, environment: environment! };
}
