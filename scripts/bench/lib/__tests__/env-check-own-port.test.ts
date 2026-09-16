// Unit coverage for `checkOwnPort`'s REAL execFile wiring (env.ts's own
// `PreflightProbes` unit test above only ever injects a fake — see its
// header comment — so nothing exercised the actual lsof/ss shell-out until
// now). Added after CI run 35152786466 on PR #793: `lsof -nP -iTCP:3200
// -sTCP:LISTEN -t` — and even the same command with the LISTEN filter
// dropped — returned nothing on the GitHub `ubuntu-latest` runner for a port
// `ss -ltnp` showed genuinely LISTENing, owned by the bench's own process.
// `checkOwnPort` now falls back to `ss` when lsof finds nothing; these tests
// mutation-kill that fallback specifically (delete it and case 2 below reds).
import { describe, expect, it, vi } from "vitest";

const execFileCalls: { file: string; args: readonly string[] }[] = [];
let execFileImpl: (file: string, args: readonly string[]) => { stdout: string };

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: readonly string[],
    callback: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
  ) => {
    execFileCalls.push({ file, args });
    try {
      const { stdout } = execFileImpl(file, args);
      callback(null, { stdout, stderr: "" });
    } catch (err) {
      callback(err as Error);
    }
  },
}));

// Imported AFTER the mock is registered (vitest hoists `vi.mock` above
// imports at transform time, so this ordering is cosmetic but kept explicit).
const { createRealPreflightProbes } = await import("../env.ts");

describe("checkOwnPort (real execFile wiring)", () => {
  it("lsof finds the PID directly -> ok, and ss is never invoked", async () => {
    execFileCalls.length = 0;
    execFileImpl = (file) => {
      if (file === "lsof") return { stdout: "4242\n" };
      throw new Error(`unexpected call to ${file}`);
    };
    const { probes, dispose } = createRealPreflightProbes();
    const result = await probes.checkOwnPort(3200);
    expect(result).toEqual({ ok: true, detail: "port 3200 is bound (LISTEN) to PID 4242.", pid: 4242 });
    expect(execFileCalls.map((c) => c.file)).toEqual(["lsof"]);
    await dispose();
  });

  it("lsof exits non-zero (no PID visible) but ss sees the listener -> ok via the fallback", async () => {
    execFileCalls.length = 0;
    execFileImpl = (file) => {
      if (file === "lsof") throw new Error("Command failed: lsof …");
      if (file === "ss") {
        return {
          stdout:
            'LISTEN 0      511          0.0.0.0:3200       0.0.0.0:*    users:(("next-server (v1",pid=4528,fd=21))\n',
        };
      }
      throw new Error(`unexpected call to ${file}`);
    };
    const { probes, dispose } = createRealPreflightProbes();
    const result = await probes.checkOwnPort(3200);
    expect(result).toEqual({
      ok: true,
      detail: "port 3200 is bound (LISTEN) to PID 4528 (via ss; lsof did not see it).",
      pid: 4528,
    });
    expect(execFileCalls.map((c) => c.file)).toEqual(["lsof", "ss"]);
    await dispose();
  });

  it("both lsof and ss find nothing -> own_port_unbound", async () => {
    execFileCalls.length = 0;
    execFileImpl = (file) => {
      if (file === "lsof") throw new Error("Command failed: lsof …");
      if (file === "ss") return { stdout: "" };
      throw new Error(`unexpected call to ${file}`);
    };
    const { probes, dispose } = createRealPreflightProbes();
    const result = await probes.checkOwnPort(3200);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "own_port_unbound" });
    await dispose();
  });

  it("ss itself errors after lsof fails -> own_port_unbound, not an unhandled rejection", async () => {
    execFileCalls.length = 0;
    execFileImpl = (file) => {
      if (file === "lsof") throw new Error("Command failed: lsof …");
      if (file === "ss") throw new Error("ss: command not found");
      throw new Error(`unexpected call to ${file}`);
    };
    const { probes, dispose } = createRealPreflightProbes();
    const result = await probes.checkOwnPort(3200);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: "own_port_unbound" });
    await dispose();
  });

  it("a foreign CLIENT socket through the port must not satisfy ss's LISTEN requirement", async () => {
    // Same trap the lsof `-sTCP:LISTEN` comment names
    // (`reference_server_ownership_check_needs_listen_filter`): `ss -Hltnp`
    // is LISTEN-only by construction (the `l` flag), so a client-only line
    // (no `LISTEN` state) must not appear at all — this asserts the ss
    // fallback stays scoped rather than falling back to a bare `-tnp`.
    execFileCalls.length = 0;
    execFileImpl = (file, args) => {
      if (file === "lsof") throw new Error("Command failed: lsof …");
      if (file === "ss") {
        expect(args).toContain("-Hltnp");
        return { stdout: "" }; // no LISTEN line for this port -> correctly empty
      }
      throw new Error(`unexpected call to ${file}`);
    };
    const { probes, dispose } = createRealPreflightProbes();
    const result = await probes.checkOwnPort(3200);
    expect(result.ok).toBe(false);
    await dispose();
  });
});
