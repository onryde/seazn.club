// Capacity tests 21 (only a camera no wait can fix ends the stay) and 22 (off and the override never enter; optional yields),
// through the REAL claim against the in-memory RealtimeKit (spec §8.1, §5.7.1, §5.7.3 step 5).
//
// Single sport, deliberately: the gate does not know a sport, and online play exists for `boardgame` only (guard.ts).
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sql } from "@/lib/db";
import type { CameraPolicy } from "@/lib/camera-policy";
import { CAMERA_EVIDENCE_DEADLINE_MS } from "@/components/public-site/match-room/room-snapshot";
import { LINE_RELEASE_GRACE_MS, LINE_RESERVATION, ownStayInLine } from "@/server/external-play/seat-line";
import { json, CAMERA_ON_EVENTS } from "./_external-play-rtk-fake";
import { organiserOverrideVideo, type CameraRefusal } from "../external-play/preflight";
import { claimAt, holdWaiting, stayRow } from "./_external-play-line";
import {
  CAMERA_DENIED_EVENTS,
  CAMERA_WENT_OFF_EVENTS,
  DEADLINE,
  MIN,
  SEC,
  claimRoom,
  dropWorlds,
  fund,
  inWindow,
  joinAt,
  seedBoard,
  world,
  OPENED,
  type Board,
  type World,
} from "./_external-play-line-route";
import { boardAnchor } from "@/server/external-play/window";

const DB = !!process.env.DATABASE_URL;
const L = LINE_RESERVATION;
const ANCHOR = boardAnchor(OPENED, 0, false);

afterEach(dropWorlds);
afterAll(async () => {
  if (DB) await sql.end();
});

const reasonOf = (seat: Awaited<ReturnType<typeof claimRoom>>["seat"]) => (seat === null ? "none" : seat.seated ? "seated" : seat.reason);

/** What each seat answer does to a stay (spec §5.7.3 step 5): the RULEBOOK, typed over the real answers, so a new camera refusal
 *  fails to compile here until it is ruled on. */
type Answer = CameraRefusal | "video_unavailable" | "seated";
const EFFECT: Record<Answer, "served" | "ended" | "stays"> = {
  seated: "served",
  camera_blocked: "ended",
  video_unavailable: "ended",
  camera_required: "stays",
  camera_lost: "stays",
  camera_starting: "stays",
};

/** Drive one answer through the real route and the fixture server; returns the claim that produced it and the stay's board. */
type Claim = Awaited<ReturnType<typeof claimRoom>>;
/** Each entry makes every claim BEFORE the one that gives the answer, and hands that last claim back to run. */
const DRIVE: Record<Answer, (w: World, b: Board) => Promise<() => Promise<Claim>>> = {
  seated: async (w, b) => {
    const t = inWindow(2 * MIN);
    const m = await claimRoom(w, b, "home", t);
    joinAt(w, m.seat, new Date(t.getTime() + SEC), CAMERA_ON_EVENTS);
    return () => claimRoom(w, b, "home", new Date(t.getTime() + 2 * SEC));
  },
  camera_blocked: async (w, b) => {
    const t = inWindow(2 * MIN);
    const m = await claimRoom(w, b, "home", t);
    joinAt(w, m.seat, new Date(t.getTime() + SEC), CAMERA_DENIED_EVENTS);
    return () => claimRoom(w, b, "home", new Date(t.getTime() + 2 * SEC));
  },
  video_unavailable: async (w, b) => {
    const t = inWindow(2 * MIN);
    const m = await claimRoom(w, b, "home", t);
    joinAt(w, m.seat, new Date(t.getTime() + SEC));
    // The report cannot be read (a vendor fault), and stays unreadable past CAMERA_EVIDENCE_DEADLINE_MS from the join.
    w.rtk.failWhen((_m, path) => (path.startsWith("/sessions/peer-report/") ? json(500, { success: false }) : null));
    const first = await claimRoom(w, b, "home", new Date(t.getTime() + 2 * SEC));
    expect(reasonOf(first.seat), "inside the wait an unreadable report is still starting").toBe("camera_starting");
    return () => claimRoom(w, b, "home", new Date(t.getTime() + SEC + CAMERA_EVIDENCE_DEADLINE_MS + SEC));
  },
  camera_required: async (w, b) => () => claimRoom(w, b, "home", inWindow(2 * MIN)), // the mint: nobody has joined
  camera_lost: async (w, b) => {
    const t = inWindow(2 * MIN);
    const m = await claimRoom(w, b, "home", t);
    joinAt(w, m.seat, new Date(t.getTime() + SEC), CAMERA_ON_EVENTS);
    const seated = await claimRoom(w, b, "home", new Date(t.getTime() + 2 * SEC));
    expect(reasonOf(seated.seat)).toBe("seated");
    // The camera that passed goes off; the next claim finds it.
    const peer = [...w.rtk.participants.values()].flatMap((p) => p.peerList).at(-1)!;
    peer.events = CAMERA_WENT_OFF_EVENTS(new Date(t.getTime() + 3 * SEC).toISOString());
    return () => claimRoom(w, b, "home", new Date(t.getTime() + 20 * SEC));
  },
  camera_starting: async (w, b) => {
    const t = inWindow(2 * MIN);
    const m = await claimRoom(w, b, "home", t);
    joinAt(w, m.seat, new Date(t.getTime() + SEC)); // pending
    return () => claimRoom(w, b, "home", new Date(t.getTime() + 2 * SEC));
  },
};

describe.skipIf(!DB)("only a camera no wait can fix ends the stay (test 21)", () => {
  it("every seat answer's effect on the stay, through the real route: a seat serves it, camera_blocked and video_unavailable end it, the rest leave it open", async () => {
    const answers = Object.keys(EFFECT) as Answer[];
    expect(answers.length, "anti-vacuity: answers ruled on").toBe(6);
    let driven = 0;
    for (const answer of answers) {
      const w = world();
      const b = await seedBoard();
      await fund(w.key, 1000);
      const last = await DRIVE[answer](w, b);
      const before = await stayRow(b.fixtureId, b.home.personId);
      const got = await last();
      expect(reasonOf(got.seat), `${answer}: the route answers it`).toBe(answer);
      const after = await stayRow(b.fixtureId, b.home.personId);
      expect(after, `${answer}: the stay exists`).not.toBeNull();
      // What THIS claim did to the stay: it newly served it, newly ended it, or neither (it stays as it was).
      const effect =
        after!.served_at !== null && before?.served_at == null ? "served" : after!.ended_at !== null && before?.ended_at == null ? "ended" : "stays";
      expect(effect, `${answer} -> ${EFFECT[answer]}`).toBe(EFFECT[answer]);
      if (EFFECT[answer] === "stays") expect([after!.ended_at], `${answer}: the stay is open`).toEqual([null]);
      driven += 1;
    }
    expect(driven, "answers driven").toBe(answers.length);
  }, 120_000);

  it("camera_blocked ENDS a queued player's stay: its reservation is released (the waiting stay is admitted with the freed tokens), it is not protected after the deadline, and its next press is a new stay; camera_required keeps place and reservation until the grace", async () => {
    // ── camera_blocked ───────────────────────────────────────────────────────────────────────────────────────────────
    const w = world();
    const p = await seedBoard();
    const t0 = new Date(DEADLINE.getTime() - 60 * SEC);
    await fund(w.key, 1000);
    const minted = await claimRoom(w, p, "home", t0);
    joinAt(w, minted.seat, new Date(t0.getTime() + SEC), CAMERA_DENIED_EVENTS);
    await fund(w.key, 0);
    // A stay waiting behind P (it arrived later) makes the line active.
    const waiter = await holdWaiting(w.key, new Date(t0.getTime() + 2 * SEC), new Date(t0.getTime() + 20 * SEC));
    // P's first read finds the budget dry: P is HELD (in line), which is what the deadline protection needs.
    const heldRead = await claimRoom(w, p, "home", new Date(t0.getTime() + 10 * SEC));
    expect(reasonOf(heldRead.seat), "P is held").toBe("queued");
    // P's read, funded for its own reservation and the read (3) and the token (1): admitted, read, camera_blocked.
    const t1 = new Date(t0.getTime() + 25 * SEC);
    await fund(w.key, L + 4);
    const blocked = await claimRoom(w, p, "home", t1);
    expect(reasonOf(blocked.seat), "the camera is refused").toBe("camera_blocked");
    const ended = await stayRow(p.fixtureId, p.home.personId);
    expect(ended?.admitted_at, "P had been admitted").not.toBeNull();
    expect(ended?.ended_at, "and the refusal ended its stay").not.toBeNull();
    expect(await ownStayInLine({ fixtureId: p.fixtureId, personId: p.home.personId, at: t1 }), "P is no longer in line").toBe(false);
    // Its reservation is released: the bucket now holds exactly LINE_RESERVATION, which the waiting stay may take at once.
    const freed = await claimAt(w.key, waiter, "home", new Date(t1.getTime() + SEC), { anchor: ANCHOR });
    expect(freed, "the waiting stay is admitted with the freed tokens").toEqual({ kind: "go", decision: "admit" });
    // Past the deadline P is NOT protected: its next press is a new stay that arrived late.
    const late = await claimRoom(w, p, "home", new Date(DEADLINE.getTime() + 5 * SEC));
    expect(reasonOf(late.seat), "P is not protected after the deadline").toBe("window_closed");
    // Before the deadline its next press is a NEW stay (restarted: not ended, arrival = the press).
    const w2 = world();
    const q = await seedBoard();
    const u0 = new Date(DEADLINE.getTime() - 4 * MIN);
    await fund(w2.key, 1000);
    const m2 = await claimRoom(w2, q, "home", u0);
    joinAt(w2, m2.seat, new Date(u0.getTime() + SEC), CAMERA_DENIED_EVENTS);
    const refused = await claimRoom(w2, q, "home", new Date(u0.getTime() + 3 * SEC));
    expect(reasonOf(refused.seat)).toBe("camera_blocked");
    const stayBefore = await stayRow(q.fixtureId, q.home.personId);
    const again = new Date(u0.getTime() + 6 * SEC);
    const second = await claimRoom(w2, q, "home", again);
    const fresh = await stayRow(q.fixtureId, q.home.personId);
    expect(stayBefore?.ended_at, "premise: the first stay had ended").not.toBeNull();
    expect(fresh?.first_claim_at, "the next press is a NEW stay: its arrival is the press").toEqual(again);
    expect(reasonOf(second.seat), "(the camera is still refused, so this new stay ends in turn)").toBe("camera_blocked");

    // ── camera_required: the stay stays in line, funded, and protected only while live ───────────────────────────────────
    const x = world();
    const r = await seedBoard();
    const r0 = new Date(DEADLINE.getTime() - 50 * SEC);
    await fund(x.key, 1000);
    const m3 = await claimRoom(x, r, "home", r0); // minted; nobody joins: camera_required
    expect(reasonOf(m3.seat)).toBe("camera_required");
    await fund(x.key, 0);
    const wait3 = await holdWaiting(x.key, new Date(r0.getTime() + 2 * SEC), new Date(r0.getTime() + 20 * SEC));
    const heldRead3 = await claimRoom(x, r, "home", new Date(r0.getTime() + 10 * SEC));
    expect(reasonOf(heldRead3.seat), "R is held").toBe("queued");
    const t3 = new Date(r0.getTime() + 25 * SEC);
    await fund(x.key, L + 4);
    const absent = await claimRoom(x, r, "home", t3);
    expect(reasonOf(absent.seat), "nobody joined: camera_required").toBe("camera_required");
    const kept = await stayRow(r.fixtureId, r.home.personId);
    expect([kept?.ended_at, kept?.admitted_at === null], "admitted and NOT ended").toEqual([null, false]);
    // The reservation is still out: with the bucket at exactly LINE_RESERVATION the waiting stay is held.
    const held = await claimAt(x.key, wait3, "home", new Date(t3.getTime() + SEC), { anchor: ANCHOR });
    expect(held.kind, "P still holds its reservation: the waiting stay is held").toBe("queued");
    // Protected past the deadline while live (its last claim is inside the grace)...
    const protectedClaim = await claimRoom(x, r, "home", new Date(DEADLINE.getTime() + 5 * SEC));
    expect(reasonOf(protectedClaim.seat), "live and arrived in time: not window_closed").not.toBe("window_closed");
    // ...and not at the release grace.
    const lapsed = new Date(DEADLINE.getTime() + 5 * SEC + LINE_RELEASE_GRACE_MS);
    const unprotected = await claimRoom(x, r, "home", lapsed);
    expect(reasonOf(unprotected.seat), "silent for the grace: no longer protected").toBe("window_closed");
  }, 120_000);
});

describe.skipIf(!DB)("off and the override never enter; optional yields (test 22)", () => {
  const policies: { name: string; policy: CameraPolicy; override: boolean; lineBusy: boolean }[] = [
    { name: "off, line non-empty", policy: "off", override: false, lineBusy: true },
    { name: "the organiser's override, line non-empty", policy: "required", override: true, lineBusy: true },
    { name: "optional, line non-empty", policy: "optional", override: false, lineBusy: true },
    { name: "optional, line empty", policy: "optional", override: false, lineBusy: false },
    { name: "required, line non-empty", policy: "required", override: false, lineBusy: true },
    { name: "required, line empty", policy: "required", override: false, lineBusy: false },
  ];

  it("6 cases: no row and no `queued` for off and the override; optional spends nothing and answers cameraRetry while the line is active, and spends as before when it is empty; required queues behind it", async () => {
    let checked = 0;
    for (const c of policies) {
      const w = world();
      const b = await seedBoard({ cameraPolicy: c.policy });
      await fund(w.key, 1000);
      const t = inWindow(3 * MIN);
      if (c.override) await organiserOverrideVideo({ fixtureId: b.fixtureId, actorUserId: b.ownerUserId, note: "the vendor is down" });
      if (c.lineBusy) await holdWaiting(w.key, new Date(t.getTime() - 2 * SEC), new Date(t.getTime() - SEC));
      const before = w.rtk.http.length;
      const got = await claimRoom(w, b, "home", t);
      const spent = w.rtk.http.length - before;
      const row = await stayRow(b.fixtureId, b.home.personId);
      const seat = got.seat;
      switch (c.name) {
        case "off, line non-empty":
        case "the organiser's override, line non-empty":
          expect(seat, c.name).toMatchObject({ seated: true, participant: null });
          expect(spent, `${c.name}: zero vendor requests`).toBe(0);
          expect(row, `${c.name}: no stay row`).toBeNull();
          break;
        case "optional, line non-empty":
          expect(seat, c.name).toMatchObject({ seated: true, participant: null, cameraRetry: true });
          expect(spent, `${c.name}: spends nothing`).toBe(0);
          expect(row, `${c.name}: never queues, no row`).toBeNull();
          break;
        case "optional, line empty":
          expect(seat, c.name).toMatchObject({ seated: true });
          expect(seat && "participant" in seat && seat.participant, `${c.name}: a token, as before`).toBeTruthy();
          expect(spent, `${c.name}: spends`).toBeGreaterThan(0);
          break;
        case "required, line non-empty":
          expect(seat, c.name).toMatchObject({ seated: false, reason: "queued" });
          expect(spent, `${c.name}: zero vendor requests`).toBe(0);
          expect(row?.queued_at, `${c.name}: held`).not.toBeNull();
          break;
        case "required, line empty":
          expect(seat, c.name).toMatchObject({ seated: false, reason: "camera_required" });
          expect(spent, `${c.name}: spends`).toBeGreaterThan(0);
          expect(row?.queued_at, `${c.name}: never held`).toBeNull();
          break;
      }
      checked += 1;
    }
    expect(checked, "cases checked").toBe(6);
  }, 120_000);
});
