// Streaming R1, A18 (G2, OWNER 2026-09-28): a stream target's `rtmpUrl` is the
// address the relay's ffmpeg dials OUT to, so an unchecked host is an SSRF
// primitive (localhost, the Fly private network, cloud metadata). The owner's
// ruling names the providers; the providers' own docs name the hosts. Expected
// values below come from those two sources — the ruling's eight provider
// names and the ingest URLs as each provider publishes them — never from the
// validator. The constant is imported only to ITERATE it, and its length is
// pinned to a literal so a silently shrunk (or grown) list reds.
import { describe, expect, it } from "vitest";
import {
  DESTINATION_REFUSALS,
  STREAM_DESTINATION_HOSTS,
  destinationRefusal,
  type DestinationRefusal,
} from "../stream-destinations";

/** A URL on `entry`'s host: an exact entry is used as is; a dot-anchored suffix
 *  gets a leftmost label, the way the provider hands out per-channel hosts. */
function hostOf(entry: (typeof STREAM_DESTINATION_HOSTS)[number]): string {
  return entry.match === "exact" ? entry.host : `ingest1${entry.host}`;
}

describe("the destination allowlist is the owner's list, pinned", () => {
  it("names exactly the eight providers A18 rules in — no more, no fewer", () => {
    const providers = new Set(STREAM_DESTINATION_HOSTS.map((e) => e.provider));
    expect([...providers].sort()).toEqual(
      ["cloudflare_stream", "facebook", "kick", "linkedin", "restream", "twitch", "vimeo", "youtube"],
    );
  });

  it("every suffix entry is dot-anchored and every exact entry is a bare host", () => {
    let checked = 0;
    for (const e of STREAM_DESTINATION_HOSTS) {
      if (e.match === "suffix") expect(e.host.startsWith("."), e.host).toBe(true);
      else expect(e.host.startsWith("."), e.host).toBe(false);
      expect(e.host, e.host).toBe(e.host.toLowerCase());
      checked++;
    }
    expect(checked).toBe(14);
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
    expect(checked).toBe(14);
  });

  it("sweep: each port a provider documents is accepted on that provider's host", () => {
    let checked = 0;
    for (const entry of STREAM_DESTINATION_HOSTS) {
      for (const port of entry.ports ?? []) {
        expect(destinationRefusal(`rtmps://${hostOf(entry)}:${port}/live`), `${entry.host}:${port}`).toBeNull();
        checked++;
      }
    }
    // Azure Media Services (LinkedIn's custom-stream ingest) documents 1936, 2935, 2936.
    expect(checked).toBe(3);
  });

  it("the ingest URLs each provider publishes, as a user pastes them, are accepted", () => {
    // Literals as each provider publishes them (the sources cited on each
    // STREAM_DESTINATION_HOSTS entry) — NOT built from the constant.
    const published = [
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
      "rtmp://12345.channel.media.azure.net:1935/live/12345",
      "rtmp://12345.channel.media.azure.net:1936/live/12345",
      "rtmps://12345.channel.media.azure.net:2935/live/12345",
      "rtmps://12345.channel.media.azure.net:2936/live/12345",
      "rtmp://live.restream.io/live",
      "rtmp://london.restream.io/live",
      "rtmps://live.cloudflare.com:443/live/",
    ];
    let checked = 0;
    for (const url of published) {
      expect(destinationRefusal(url), url).toBeNull();
      checked++;
    }
    expect(checked).toBe(19);
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
    // Ports nobody documents, and a documented port on the WRONG provider.
    ["rtmps://a.rtmps.youtube.com:1936/live2", "port"],
    ["rtmps://a.rtmps.youtube.com:2935/live2", "port"],
    ["rtmp://a.rtmp.youtube.com:443/live2", "port"],
    ["rtmps://a.rtmps.youtube.com:1935/live2", "port"],
    ["rtmps://live.cloudflare.com:8080/live/", "port"],
    ["rtmps://x.channel.media.azure.net:4280/live/x", "port"],
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
    expect(checked).toBe(58);
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
    expect(checked).toBe(14);
  });

  it("the verdict is a rule name, never an echo of the URL (it can carry a stream key)", () => {
    const url = "rtmps://127.0.0.1/app/live_sk_SECRET";
    const reason = destinationRefusal(url);
    expect(reason).toBe("ip_literal");
    expect(DESTINATION_REFUSALS).toContain(reason);
    expect(String(reason)).not.toContain("SECRET");
  });
});
