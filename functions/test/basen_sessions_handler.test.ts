/**
 * GET /api/basen/sessions — handler na fake Firestore (PRODUKCYJNY kod).
 * Pilnuje odpowiedzi po zrównolegleniu odczytów (29.10.2026): widok członka,
 * 403 dla nieznanego użytkownika (bez nieobsłużonej obietnicy), finance bez uprawnień.
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {handleGetBasenSessions} from "../src/api/getBasenSessionsHandler";
import {enrollInSlot, getBasenVars} from "../src/modules/basen/basen_service";
import {warsawTodayIso} from "../src/modules/basen/basen_finance";

function session(date: string) {
  return {
    _docId: date, id: date, date, notes: "", costPln: 350,
    slots: {
      H1: {timeStart: "23:00", timeEnd: "23:00", capacity: 2, enrolledCount: 0, status: "open"},
      H2: {timeStart: "23:45", timeEnd: "23:45", capacity: 2, enrolledCount: 0, status: "open"},
    },
  };
}

async function call(db: any, uid: string, query: any = {}) {
  let status = 0;
  let json: any = null;
  const res: any = {status: (s: number) => ({json: (j: any) => {
    status = s; json = j;
  }})};
  await handleGetBasenSessions({method: "GET", query} as any, res, {
    db,
    sendPreflight: () => false,
    requireAllowedHost: () => true,
    setCorsHeaders: () => undefined,
    corsHandler: (_req, _res, next) => next(),
    requireIdToken: async () => ({decoded: {uid, email: `${uid}@x.pl`}}),
    adminRoleKeys: ["rola_zarzad", "rola_kr"],
  });
  // corsHandler woła async callback bez await — poczekaj na jego zakończenie.
  for (let i = 0; i < 40 && !status; i++) await new Promise((r) => setTimeout(r, 5));
  return {status, json};
}

function dbWith() {
  const d = warsawTodayIso();
  return {d, db: new FakeFirestore({
    basen_sessions: [session(d)],
    basen_godziny_ledger: [{uid: "a", type: "admin_add", amount: 2, unitPricePln: 35, createdAt: new Date("2026-10-01")}],
    users_active: [
      {_docId: "a", email: "a@x.pl", role_key: "rola_czlonek", status_key: "status_aktywny"},
    ],
  }).asDb()};
}

describe("GET /api/basen/sessions", () => {
  it("widok członka: termin, własny zapis, liczniki sezonu i saldo wejść", async () => {
    const {d, db} = dbWith();
    await enrollInSlot(db, {sessionId: d, slot: "H1", uid: "a", email: "a@x.pl", displayName: "a", mode: "regular", isKursant: false, vars: await getBasenVars(db)});

    const r = await call(db, "a");
    expect(r.status).toBe(200);
    expect(r.json.sessions).toHaveLength(1);
    const s = r.json.sessions[0];
    expect(s).toMatchObject({id: d, date: d, isPast: false});
    expect(s.slots.H1).toMatchObject({userEnrolled: true, enrolledCount: 1, remaining: 1, waitlistCount: 0, waitlistNames: []});
    expect(s.slots.H1.attendees).toHaveLength(1);
    expect(s.slots.H2).toMatchObject({userEnrolled: false, enrolledCount: 0, remaining: 2});
    expect(r.json.userGodzinyBalance).toBe(1);
    expect(r.json.season).toMatchObject({minZapisow: 12, maxDniNaprzod: 4, oknoH: 30});
  });

  it("nieznany użytkownik → 403", async () => {
    const {db} = dbWith();
    const r = await call(db, "ghost");
    expect(r).toEqual({status: 403, json: {error: "User not found"}});
  });

  it("view=finance dla członka → 403", async () => {
    const {db} = dbWith();
    const r = await call(db, "a", {view: "finance"});
    expect(r.status).toBe(403);
  });
});
