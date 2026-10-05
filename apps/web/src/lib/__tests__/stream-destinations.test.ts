// Streaming R1, A18 (G2, OWNER 2026-09-28): a stream target's `rtmpUrl` is the
// address the relay's ffmpeg dials OUT to, so an unchecked host is an SSRF
// primitive (localhost, the Fly private network, cloud metadata). The owner's
// ruling names the providers; the providers' own docs name the hosts. Expected
// values below come from those two sources — the ruling's provider names and
// the ingest URLs as each provider publishes them — never from the validator.
// The constant is imported only to ITERATE it, and its length is pinned to a
// literal so a silently shrunk (or grown) list reds.
//
// LinkedIn is the one A18 provider NOT admitted in R1 (fix round 2, orchestrator
// ruling 2026-09-28): its only sourced ingest, Azure Media Services'
// `*.channel.media.azure.net`, is NXDOMAIN since AMS retired (2024-06). The
// tests below pin its absence as deliberately as the others' presence.
import { describe, expect, it } from "vitest";
import {
  DESTINATION_REFUSALS,
  STREAM_DESTINATION_HOSTS,
  STREAM_PLATFORMS,
  STREAM_PLATFORM_PRESETS,
  checkDestination,
  destinationIdentity,
  isStreamPlatform,
  resolveStreamTarget,
  type DestinationRefusal,
  type SavedStreamTarget,
} from "../stream-destinations";
import { StreamTargetKind } from "@/server/api-v1/schemas";
import { STREAM_TARGET_TABLE, STREAM_TARGET_TABLE_ROWS, rowName, type TargetRow } from "./_stream-target-table";

/** The rule `checkDestination` refused `url` for, or null when it admits it — the ONE validator's verdict, read as a rule.
 *  (n4, B4 re-review: the lib's `destinationRefusal` wrapper had no production caller and was deleted; the tests keep
 *  asking the validator itself.) */
const destinationRefusal = (url: string): DestinationRefusal | null => {
  const v = checkDestination(url);
  return v.ok ? null : v.rule;
};

/** U+212A KELVIN SIGN — the one non-ASCII code point whose toLowerCase() is ASCII ("k"). Built, not typed. */
const KELVIN = String.fromCharCode(0x212a);

/** A URL on `entry`'s host: an exact entry is used as is; a dot-anchored suffix
 *  gets a leftmost label, the way the provider hands out per-channel hosts. */
function hostOf(entry: (typeof STREAM_DESTINATION_HOSTS)[number]): string {
  return entry.match === "exact" ? entry.host : `ingest1${entry.host}`;
}

/** Literals as each provider publishes them (the sources cited on each
 *  STREAM_DESTINATION_HOSTS entry) — NOT built from the constant. All lower-case,
 *  exactly as published, so each is already its own canonical form. */
const PUBLISHED = [
  "rtmp://a.rtmp.youtube.com/live2",
  "rtmp://b.rtmp.youtube.com/live2?backup=1",
  "rtmps://a.rtmps.youtube.com:443/live2",
  "rtmps://b.rtmps.youtube.com:443/live2?backup=1",
  "rtmps://live-api-s.facebook.com:443/rtmp/",
  "rtmps://rtmp-api.facebook.com:443/rtmp/",
  "rtmps://ingest.global-contribute.live-video.net/app/",
  "rtmp://euw30.contribute.live-video.net/app/",
  "rtmp://live-jfk.twitch.tv/app",
  "rtmps://fa723fc1b171.global-contribute.live-video.net:443/app",
  "rtmps://rtmp-global.cloud.vimeo.com:443/live",
  "rtmp://rtmp.cloud.vimeo.com/live",
  "rtmp://live.restream.io/live",
  "rtmp://london.restream.io/live",
  "rtmps://live.cloudflare.com:443/live/",
] as const;

/** `url` with its authority (host[:port]) upper-cased and every other byte untouched. */
function upperHost(url: string): string {
  const m = /^(rtmps?:\/\/)([^/]*)(.*)$/.exec(url);
  if (!m) throw new Error(`not an rtmp url: ${url}`);
  return m[1]! + m[2]!.toUpperCase() + m[3]!;
}

describe("the destination allowlist is the owner's list, pinned", () => {
  it("names exactly A18's providers minus LinkedIn — seven, no more, no fewer", () => {
    const providers = new Set(STREAM_DESTINATION_HOSTS.map((e) => e.provider));
    expect([...providers].sort()).toEqual(
      ["cloudflare_stream", "facebook", "kick", "restream", "twitch", "vimeo", "youtube"],
    );
    expect(providers.size).toBe(7);
  });

  it("LinkedIn is deliberately absent: no entry names it, and its last sourced ingest (Azure Media Services) is refused", () => {
    expect(STREAM_DESTINATION_HOSTS.filter((e) => e.provider === "linkedin")).toEqual([]);
    expect(STREAM_DESTINATION_HOSTS.filter((e) => e.host.includes("azure"))).toEqual([]);
    // The four ingest URLs LinkedIn's "Live Events APIs" doc (2023-12-20) handed out — all on a retired namespace.
    const retired = [
      "rtmp://12345.channel.media.azure.net:1935/live/12345",
      "rtmp://12345.channel.media.azure.net:1936/live/12345",
      "rtmps://12345.channel.media.azure.net:2935/live/12345",
      "rtmps://12345.channel.media.azure.net:2936/live/12345",
    ];
    let checked = 0;
    for (const url of retired) {
      expect(destinationRefusal(url), url).toBe("host");
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("every suffix entry is dot-anchored and every exact entry is a bare host", () => {
    let checked = 0;
    for (const e of STREAM_DESTINATION_HOSTS) {
      if (e.match === "suffix") expect(e.host.startsWith("."), e.host).toBe(true);
      else expect(e.host.startsWith("."), e.host).toBe(false);
      expect(e.host, e.host).toBe(e.host.toLowerCase());
      expect(e.host, e.host).toMatch(/^[a-z0-9.-]+$/);
      checked++;
    }
    expect(checked).toBe(13);
  });
});

describe("every allowlisted host is accepted", () => {
  it("sweep: each entry, on both schemes at their default port, is accepted — count = list length", () => {
    let checked = 0;
    for (const entry of STREAM_DESTINATION_HOSTS) {
      const host = hostOf(entry);
      expect(destinationRefusal(`rtmps://${host}/live`), `rtmps ${host}`).toBeNull();
      expect(destinationRefusal(`rtmp://${host}/live`), `rtmp ${host}`).toBeNull();
      // The default port spelled out is the same destination.
      expect(destinationRefusal(`rtmps://${host}:443/live`), `rtmps ${host}:443`).toBeNull();
      expect(destinationRefusal(`rtmp://${host}:1935/live`), `rtmp ${host}:1935`).toBeNull();
      // DNS is case-insensitive; a pasted upper-case host is the same host.
      expect(destinationRefusal(`rtmps://${host.toUpperCase()}/live`), `upper ${host}`).toBeNull();
      checked++;
    }
    expect(checked).toBe(STREAM_DESTINATION_HOSTS.length);
    expect(checked).toBe(13);
  });

  it("sweep: no listed provider publishes a non-default port, so each entry refuses the OTHER scheme's default and LinkedIn's old ports", () => {
    let checked = 0;
    for (const entry of STREAM_DESTINATION_HOSTS) {
      const host = hostOf(entry);
      expect(destinationRefusal(`rtmps://${host}:1935/live`), `rtmps ${host}:1935`).toBe("port");
      expect(destinationRefusal(`rtmp://${host}:443/live`), `rtmp ${host}:443`).toBe("port");
      expect(destinationRefusal(`rtmps://${host}:2935/live`), `rtmps ${host}:2935`).toBe("port");
      expect(destinationRefusal(`rtmp://${host}:1936/live`), `rtmp ${host}:1936`).toBe("port");
      checked++;
    }
    expect(checked).toBe(13);
  });

  it("the ingest URLs each provider publishes, as a user pastes them, are accepted", () => {
    let checked = 0;
    for (const url of PUBLISHED) {
      expect(destinationRefusal(url), url).toBeNull();
      checked++;
    }
    expect(checked).toBe(15);
  });
});

describe("the URL that is sealed and dialled is the URL that was checked", () => {
  it("checkDestination returns the canonical URL: an upper-case host comes back lower-cased, every other byte as given, and re-checks to itself", () => {
    let checked = 0;
    for (const url of PUBLISHED) {
      // Already canonical (published lower-case): returned byte for byte.
      expect(checkDestination(url), url).toEqual({ ok: true, url });
      // Upper-cased host: the canonical form is the published literal — expected value typed above, not computed.
      const pasted = upperHost(url);
      expect(pasted).not.toBe(url);
      expect(checkDestination(pasted), pasted).toEqual({ ok: true, url });
      checked++;
    }
    expect(checked).toBe(15);
  });

  it("a refused URL yields its rule and no URL at all", () => {
    const refused: [string, DestinationRefusal][] = [
      ["rtmp://localhost/live", "host"],
      [`rtmps://live-api-s.faceboo${KELVIN}.com:443/rtmp/`, "host"],
      ["rtmps://a.rtmps.youtube.com:1936/live2", "port"],
    ];
    let checked = 0;
    for (const [url, rule] of refused) {
      expect(checkDestination(url), url).toEqual({ ok: false, rule });
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("sweep: every non-ASCII code point whose toLowerCase() is ASCII is refused inside a listed host, while its ASCII twin is accepted", () => {
    // The set comes from the JS runtime's case tables, not from the validator. Reviewer
    // (re-review round 1, m1) enumerated it as exactly U+212A; the sweep re-derives it.
    const foldsToAscii: number[] = [];
    for (let cp = 0x80; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (/^[a-z0-9-]+$/.test(String.fromCodePoint(cp).toLowerCase())) foldsToAscii.push(cp);
    }
    expect(foldsToAscii).toContain(0x212a);
    let checked = 0;
    for (const cp of foldsToAscii) {
      const raw = String.fromCodePoint(cp);
      const twin = raw.toLowerCase();
      // A leftmost label under a listed suffix: the twin is accepted, so only the raw byte can refuse it.
      expect(destinationRefusal(`rtmps://${twin}.restream.io/live`), `twin of U+${cp.toString(16)}`).toBeNull();
      expect(destinationRefusal(`rtmps://${raw}.restream.io/live`), `U+${cp.toString(16)}`).toBe("host");
      checked++;
    }
    expect(checked, "fold-to-ASCII code points checked").toBeGreaterThan(0);
    expect(checked).toBe(foldsToAscii.length);
  });
});

describe("everything else is refused, with the rule that refused it", () => {
  const cases: [string, DestinationRefusal][] = [
    // Loopback, private, link-local, metadata — named and numeric.
    ["rtmp://localhost/live", "host"],
    ["rtmp://localhost.localdomain/live", "host"],
    ["rtmp://127.0.0.1/live", "ip_literal"],
    ["rtmp://10.0.0.1/live", "ip_literal"],
    ["rtmp://192.168.1.10/live", "ip_literal"],
    ["rtmp://169.254.169.254/live", "ip_literal"],
    ["rtmp://[::1]/live", "ip_literal"],
    ["rtmp://[fdaa::1]:1935/live", "ip_literal"],
    ["rtmp://[::ffff:127.0.0.1]/live", "ip_literal"],
    ["rtmp://::1/live", "host"],
    // getaddrinfo spellings of 127.0.0.1 that are not dotted quads.
    ["rtmp://2130706433/live", "ip_literal"],
    ["rtmp://0x7f000001/live", "ip_literal"],
    ["rtmp://0x7f.1/live", "ip_literal"],
    ["rtmp://127.1/live", "ip_literal"],
    ["rtmp://0177.0.0.1/live", "ip_literal"],
    // The Fly private network.
    ["rtmp://relay.internal/live", "host"],
    ["rtmp://top1.nearest.of.seazn-relay.internal/live", "host"],
    ["rtmp://_api.internal:4280/live", "host"],
    ["rtmp://seazn-relay.flycast/live", "host"],
    // Lookalikes: a listed name inside, or glued to, a host that is not listed.
    ["rtmps://youtube.com.evil.io/live2", "host"],
    ["rtmps://a.rtmps.youtube.com.evil.io/live2", "host"],
    ["rtmps://evilyoutube.com/live2", "host"],
    ["rtmps://youtube.com/live2", "host"],
    ["rtmps://x.a.rtmps.youtube.com/live2", "host"],
    ["rtmps://restream.io/live", "host"],
    ["rtmps://evilrestream.io/live", "host"],
    ["rtmps://live-video.net/app/", "host"],
    ["rtmps://evil-contribute.live-video.net/app/", "host"],
    ["rtmps://a.rtmps.youtube.com./live2", "host"],
    ["rtmps://a.rtmps.youtube.com%2eevil.io/live2", "host"],
    ["rtmps://evil.io\\a.rtmps.youtube.com/live2", "host"],
    ["rtmps:///live2", "host"],
    // Non-ASCII hosts: checked on the RAW bytes, before any case-folding (re-review m1).
    [`rtmps://live-api-s.faceboo${KELVIN}.com:443/rtmp/`, "host"],
    [`rtmps://${String.fromCharCode(0xff4c)}ive.cloudflare.com/live/`, "host"],
    ["rtmps://xn--facebok-8ya.com/rtmp/", "host"],
    // LinkedIn's retired Azure Media Services ingest — deliberately not admitted in R1.
    ["rtmps://12345.channel.media.azure.net:2935/live/12345", "host"],
    ["rtmp://12345.channel.media.azure.net:1935/live/12345", "host"],
    ["rtmps://x.channel.media.azure.net:4280/live/x", "host"],
    // Userinfo, including the parser-confusion shapes that smuggle an @.
    ["rtmps://user:pw@a.rtmps.youtube.com/live2", "userinfo"],
    ["rtmps://a.rtmps.youtube.com@evil.io/live2", "userinfo"],
    ["rtmps://evil.io\\@a.rtmps.youtube.com/live2", "userinfo"],
    ["rtmps://evil.io#@a.rtmps.youtube.com/live2", "userinfo"],
    // Not an RTMP ingest.
    ["http://a.rtmp.youtube.com/live2", "scheme"],
    ["https://a.rtmps.youtube.com/live2", "scheme"],
    ["srt://live.cloudflare.com:778/x", "scheme"],
    ["rtmpt://a.rtmp.youtube.com/live2", "scheme"],
    ["RTMP://a.rtmp.youtube.com/live2", "scheme"],
    [" rtmps://a.rtmps.youtube.com/live2", "scheme"],
    ["", "scheme"],
    // Ports no listed provider publishes.
    ["rtmps://a.rtmps.youtube.com:1936/live2", "port"],
    ["rtmps://a.rtmps.youtube.com:2935/live2", "port"],
    ["rtmp://a.rtmp.youtube.com:443/live2", "port"],
    ["rtmps://a.rtmps.youtube.com:1935/live2", "port"],
    ["rtmps://live.cloudflare.com:8080/live/", "port"],
    ["rtmps://a.rtmps.youtube.com:0/live2", "port"],
    ["rtmps://a.rtmps.youtube.com:/live2", "port"],
    ["rtmps://a.rtmps.youtube.com:99999/live2", "port"],
    ["rtmps://a.rtmps.youtube.com:0443/live2", "port"],
    ["rtmps://a.rtmps.youtube.com:443:443/live2", "host"],
    // No application path.
    ["rtmps://a.rtmps.youtube.com", "path"],
    ["rtmps://a.rtmps.youtube.com/", "path"],
    ["rtmps://a.rtmps.youtube.com/live 2", "path"],
    ["rtmps://a.rtmps.youtube.com/live2\n", "path"],
  ];

  it("refusal table: each case refused for its named rule", () => {
    let checked = 0;
    for (const [url, reason] of cases) {
      expect(destinationRefusal(url), JSON.stringify(url)).toBe(reason);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(checked).toBe(63);
  });

  it("the table reaches every refusal rule the validator declares", () => {
    const reached = new Set(cases.map(([, r]) => r));
    expect([...reached].sort()).toEqual([...DESTINATION_REFUSALS].sort());
    expect(DESTINATION_REFUSALS.length).toBe(6);
  });

  it("sweep: every entry's lookalikes are refused — suffix appended, apex, glued prefix", () => {
    let checked = 0;
    for (const entry of STREAM_DESTINATION_HOSTS) {
      const host = hostOf(entry);
      expect(destinationRefusal(`rtmps://${host}.evil.io/live`), `${host}.evil.io`).toBe("host");
      if (entry.match === "suffix") {
        const apex = entry.host.slice(1);
        expect(destinationRefusal(`rtmps://${apex}/live`), `apex ${apex}`).toBe("host");
        expect(destinationRefusal(`rtmps://evil${apex}/live`), `evil${apex}`).toBe("host");
      } else {
        expect(destinationRefusal(`rtmps://evil${host}/live`), `evil${host}`).toBe("host");
        expect(destinationRefusal(`rtmps://x.${host}/live`), `x.${host}`).toBe("host");
      }
      checked++;
    }
    expect(checked).toBe(13);
  });

  it("the verdict is a rule name, never an echo of the URL (it can carry a stream key)", () => {
    const url = "rtmps://127.0.0.1/app/live_sk_SECRET";
    const reason = destinationRefusal(url);
    expect(reason).toBe("ip_literal");
    expect(DESTINATION_REFUSALS).toContain(reason);
    expect(String(reason)).not.toContain("SECRET");
  });
});

// ---------------------------------------------------------------------------
// A19b (Task 9 re-review round 2, must-fix in Task 10): ONE identity per
// destination. checkDestination's canonical url keeps an explicit port exactly
// as given, so `…:443/rtmp/` and `…/rtmp/` are two strings for one broadcast
// slot — and the destination FINGERPRINT (server/relay/crypto.ts, V421) must
// not see two. The default ports below are the PROTOCOLS' own, typed here from
// their sources — RTMP's registered 1935 (Adobe RTMP spec; IANA
// "macromedia-fcs") and RTMPS on 443 as every PUBLISHED rtmps literal above
// spells it — never read back from the validator.
// ---------------------------------------------------------------------------
const SCHEME_DEFAULT_PORT = { rtmp: 1935, rtmps: 443 } as const;

describe("destinationIdentity — one destination, one identity (A19b)", () => {
  it("sweep: an explicit scheme-default port and no port are ONE identity, for every listed host under both schemes — and the bare form IS the identity", () => {
    let checked = 0;
    for (const entry of STREAM_DESTINATION_HOSTS) {
      for (const scheme of ["rtmp", "rtmps"] as const) {
        const bare = `${scheme}://${hostOf(entry)}/app/`;
        const ported = `${scheme}://${hostOf(entry)}:${SCHEME_DEFAULT_PORT[scheme]}/app/`;
        expect(destinationIdentity(ported), ported).toBe(bare);
        expect(destinationIdentity(bare), bare).toBe(bare);
        checked++;
      }
    }
    expect(checked).toBe(STREAM_DESTINATION_HOSTS.length * 2);
    expect(checked).toBe(26);
  });

  it("the owner's two cases by name: rtmps :443 (Facebook) and rtmp :1935 (YouTube) each equal their port-less spelling", () => {
    expect(destinationIdentity("rtmps://live-api-s.facebook.com:443/rtmp/")).toBe(destinationIdentity("rtmps://live-api-s.facebook.com/rtmp/"));
    expect(destinationIdentity("rtmp://a.rtmp.youtube.com:1935/live2")).toBe(destinationIdentity("rtmp://a.rtmp.youtube.com/live2"));
    expect(destinationIdentity("rtmps://live-api-s.facebook.com:443/rtmp/")).toBe("rtmps://live-api-s.facebook.com/rtmp/");
  });

  it("it is not a constant: another host, path, query or scheme is another identity; the host folds as checkDestination folds it", () => {
    const base = "rtmps://a.rtmps.youtube.com/live2";
    const others = [
      "rtmps://b.rtmps.youtube.com/live2",          // YouTube's backup ingest is a different host
      "rtmps://a.rtmps.youtube.com/live3",
      "rtmps://a.rtmps.youtube.com/live2?backup=1",
      "rtmp://a.rtmp.youtube.com/live2",
    ];
    let checked = 0;
    for (const other of others) {
      expect(destinationIdentity(other), other).not.toBeNull();
      expect(destinationIdentity(other), other).not.toBe(destinationIdentity(base));
      checked++;
    }
    expect(checked).toBe(4);
    expect(destinationIdentity("rtmps://A.RTMPS.YouTube.com:443/live2")).toBe(base);
  });

  it("a refused URL has NO identity — one case per refusal rule, so nothing undialable can ever be fingerprinted", () => {
    const refused: [string, DestinationRefusal][] = [
      ["http://a.rtmp.youtube.com/live2", "scheme"],
      ["rtmps://u:p@a.rtmps.youtube.com/live2", "userinfo"],
      ["rtmps://127.0.0.1/live2", "ip_literal"],
      ["rtmps://evil.example/live2", "host"],
      ["rtmps://a.rtmps.youtube.com:1935/live2", "port"],
      ["rtmps://a.rtmps.youtube.com", "path"],
    ];
    const rules = new Set<DestinationRefusal>();
    for (const [url, rule] of refused) {
      expect(destinationRefusal(url), url).toBe(rule);   // the case is refused for the rule it names…
      expect(destinationIdentity(url), url).toBeNull();  // …and has no identity
      rules.add(rule);
    }
    expect([...rules].sort()).toEqual([...DESTINATION_REFUSALS].sort());
  });
});

// ---------------------------------------------------------------------------
// D6 (owner 2026-09-30, spec §5.4): a NEW destination names a platform, and the
// server fills its ingest url from that platform's preset — so the one
// validator must admit every preset, or create refuses every add for it.
// ---------------------------------------------------------------------------
describe("platform presets (D6)", () => {
  it("every platform preset passes checkDestination, and every platform has one (D6)", () => {
    let checked = 0;
    for (const p of STREAM_PLATFORMS) {
      expect(checkDestination(STREAM_PLATFORM_PRESETS[p]), p).toMatchObject({ ok: true });
      checked++;
    }
    expect(checked).toBe(STREAM_PLATFORMS.length);
    expect(Object.keys(STREAM_PLATFORM_PRESETS).sort()).toEqual([...STREAM_PLATFORMS].sort());
  });

  it("isStreamPlatform (B2 review nit — the ONE platform-kind test, for Replace key's recovery and the unreadable remedy): true for every platform; false for every stored legacy kind, a wrong case, and prototype keys", () => {
    let checked = 0;
    for (const p of STREAM_PLATFORMS) {
      expect(isStreamPlatform(p), p).toBe(true);
      checked++;
    }
    // The legacy kinds are the wire enum's own, less the platforms (D6) — a kind added to either moves this sweep.
    const legacy = StreamTargetKind.options.filter((k) => !(STREAM_PLATFORMS as readonly string[]).includes(k));
    expect(legacy.length, "no legacy kind to refuse").toBeGreaterThan(0);
    for (const k of [...legacy, "", "YouTube", "constructor", "toString"]) {
      expect(isStreamPlatform(k), JSON.stringify(k)).toBe(false);
      checked++;
    }
    expect(checked).toBe(STREAM_PLATFORMS.length + legacy.length + 4);
  });

  // Moved here in T2a from stream-targets.test.ts, whose A18 cases drove these URLs through createStreamTarget's
  // `rtmpUrl` — a field D6 removed. Only the URLs the refusal table and PUBLISHED above did not already pin are moved;
  // expected rules and canonical forms are typed as they were there, never read back from the validator.
  it("moved from stream-targets.test.ts (create takes no url since D6): the route's three off-list urls refuse by rule; two pasted spellings seal their canonical form", () => {
    const refused: [string, DestinationRefusal][] = [
      ["rtmp://seazn-relay.internal:1935/live", "host"],
      ["rtmps://169.254.169.254/latest", "ip_literal"],
      ["https://not-an-ingest.example/app", "scheme"],
    ];
    let checked = 0;
    for (const [url, rule] of refused) {
      expect(checkDestination(url), url).toEqual({ ok: false, rule });
      checked++;
    }
    const canonical: [string, string][] = [
      ["rtmps://A.RTMPS.YOUTUBE.COM:443/live2?backup=1", "rtmps://a.rtmps.youtube.com:443/live2?backup=1"],
      ["rtmp://Live.Restream.IO/Live", "rtmp://live.restream.io/Live"],
    ];
    for (const [pasted, sealed] of canonical) {
      expect(checkDestination(pasted), pasted).toEqual({ ok: true, url: sealed });
      checked++;
    }
    expect(checked).toBe(5);
  });
});

// B8 review I-1 (controller ruling): the ONE default-target resolver. Its table is shared with the DB agreement test and
// the panel's (`_stream-target-table.ts`), and its expected values are the rule text's, written out there.
describe("resolveStreamTarget — §6.7.3 / n1 / T36: what the fixture streams to", () => {
  const ID = { A: "id-a", B: "id-b" } as const;
  /** A row's inputs: its live destinations oldest first, and its saved row as the server reads it. */
  function inputs(r: TargetRow): { saved: SavedStreamTarget; live: { id: string }[] } {
    const live = r.live.map((n) => ({ id: ID[n] }));
    const newest = live[live.length - 1]?.id ?? "id-ghost";
    const saved: SavedStreamTarget =
      r.saved === "none" ? { row: false }
      : r.saved === "cleared" ? { row: true, targetId: null, live: false }
      : r.saved === "live" ? { row: true, targetId: newest, live: true }
      : r.saved === "archived" ? { row: true, targetId: "id-archived", live: false }
      : { row: true, targetId: "id-other-org", live: false };
    return { saved, live };
  }

  it("the table: 5 saved shapes × {0, 1, 2} live destinations — the empty case first, every row its rule's answer", () => {
    expect(STREAM_TARGET_TABLE[0], "the empty case first").toEqual({ saved: "none", live: [], expect: null });
    let checked = 0;
    for (const r of STREAM_TARGET_TABLE) {
      const { saved, live } = inputs(r);
      const want = r.expect === null ? null : { id: ID[r.expect.pick], source: r.expect.source };
      expect(resolveStreamTarget(saved, live), rowName(r)).toEqual(want);
      checked++;
    }
    expect(checked).toBe(STREAM_TARGET_TABLE_ROWS);
    expect(new Set(STREAM_TARGET_TABLE.map(rowName)).size, "15 DISTINCT rows").toBe(STREAM_TARGET_TABLE_ROWS);
  });

  it("the guard: a saved choice marked live that the live list does not hold is NONE — never the oldest in its place", () => {
    const live = [{ id: ID.A }, { id: ID.B }];
    expect(resolveStreamTarget({ row: true, targetId: "id-z", live: true }, live)).toBeNull();
    // The positive pair: the same row, listed, is the choice.
    expect(resolveStreamTarget({ row: true, targetId: ID.B, live: true }, live)).toEqual({ id: ID.B, source: "saved" });
  });

  it("a second call on the same inputs is the same answer, and the inputs are not touched", () => {
    const live = Object.freeze([Object.freeze({ id: ID.A }), Object.freeze({ id: ID.B })]);
    const saved = Object.freeze({ row: false as const });
    const first = resolveStreamTarget(saved, live);
    expect(resolveStreamTarget(saved, live)).toEqual(first);
    expect(first).toEqual({ id: ID.A, source: "default" });
  });
});
