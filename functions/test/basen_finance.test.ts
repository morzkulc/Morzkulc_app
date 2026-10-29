/**
 * Zasady basenu z regulaminu (28.10.2026): wycena wejść FIFO, wynik terminu, reguła
 * uruchomienia (🟢/🟡/🔴), lista rezerwowa, limit terminów naprzód, decyzja 30 h przed.
 * Wykonuje PRODUKCYJNY kod basen_finance.ts / basen_service.ts / basen_season.ts /
 * basenDecideSessions.ts na fake Firestore.
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {
  addDaysIso, enrollmentIsPaid, nextEntryValuePln, seasonOf, sessionLight, sessionMoney, warsawLocalMs, warsawTodayIso,
} from "../src/modules/basen/basen_finance";
import {
  cancelEnrollment, cancelSession, enrollInSlot, getBasenVars, joinWaitlist, sessionDecisionMs,
} from "../src/modules/basen/basen_service";
import {computeSeason} from "../src/modules/basen/basen_season";
import {priceProduct} from "../src/modules/basen/basen_godziny_service";
import {basenDecideSessionsTask} from "../src/service/tasks/basenDecideSessions";

const FV = {koszt_terminu: 350, max_strata_terminu: 105, budzet_sezonu: 2000};

describe("czas warszawski i sezon", () => {
  it("21:00 w listopadzie = 20:00 UTC; decyzja 30 h przed = 15:00 dnia poprzedniego", () => {
    const start = warsawLocalMs("2026-11-10", "21:00");
    expect(start).toBe(Date.parse("2026-11-10T20:00:00Z"));
    const decision = sessionDecisionMs({date: "2026-11-10", slots: {H1: {timeStart: "21:00"} as any, H2: {timeStart: "21:45"} as any}}, 30);
    expect(decision).toBe(warsawLocalMs("2026-11-09", "15:00"));
  });

  it("sezon od 1 lipca; karnet ważny do 31 marca", () => {
    expect(seasonOf("2026-11-10")).toEqual({key: "2026/27", start: "2026-07-01", end: "2027-06-30", karnetValidUntil: "2027-03-31"});
    expect(seasonOf("2027-03-01").key).toBe("2026/27");
    expect(seasonOf("2027-07-01").key).toBe("2027/28");
  });
});

describe("cennik i wycena wejść (FIFO)", () => {
  const v = {basen_cena_za_godzine: 35, basen_cena_karnet_5: 140, basen_cena_karnet_10: 245};

  it("produkty z cennika", () => {
    expect(priceProduct("jednorazowe", 3, v)).toMatchObject({entries: 3, unitPricePln: 35, amountPln: 105});
    expect(priceProduct("karnet5", 0, v)).toMatchObject({entries: 5, unitPricePln: 28, amountPln: 140});
    expect(priceProduct("karnet10", 0, v)).toMatchObject({entries: 10, unitPricePln: 24.5, amountPln: 245});
  });

  it("wejścia schodzą z partii w kolejności zakupu; nagroda instruktora = 0 zł; zwrot cofa zużycie", () => {
    const recs: any[] = [
      {id: "a", type: "admin_add", amount: 2, unitPricePln: 35, createdAt: new Date("2026-11-01")},
      {id: "b", type: "instructor_reward", amount: 1, createdAt: new Date("2026-11-02")},
      {id: "c", type: "admin_add", amount: 5, unitPricePln: 28, createdAt: new Date("2026-11-03")},
    ];
    expect(nextEntryValuePln(recs, 35)).toBe(35);
    recs.push({type: "booking_block", amount: -1}, {type: "booking_block", amount: -1});
    expect(nextEntryValuePln(recs, 35)).toBe(0);
    recs.push({type: "booking_block", amount: -1});
    expect(nextEntryValuePln(recs, 35)).toBe(28);
    recs.push({type: "booking_refund", amount: 1});
    expect(nextEntryValuePln(recs, 35)).toBe(0);
  });
});

describe("wynik terminu i reguła uruchomienia", () => {
  it("przychód: aktywne płatne + spóźnione rezygnacje bez zwrotu; bez instruktorów i puli kursanckiej", () => {
    const base = {sessionId: "s", slot: "H1", valuePln: 35};
    expect(enrollmentIsPaid({...base, type: "regular", status: "active"})).toBe(true);
    expect(enrollmentIsPaid({...base, type: "instructor", status: "active"})).toBe(false);
    expect(enrollmentIsPaid({...base, type: "regular", status: "active", chargedGodziny: false})).toBe(false);
    expect(enrollmentIsPaid({...base, type: "regular", status: "cancelled", cancelledLate: true})).toBe(true);
    expect(enrollmentIsPaid({...base, type: "regular", status: "cancelled", cancelledLate: true, lateRefunded: true})).toBe(false);
    expect(enrollmentIsPaid({...base, type: "regular", status: "cancelled"})).toBe(false);
  });

  it("10 wejść × 35 zł = 0 zł → 🟢; strata 105 zł → 🟡; 106 zł → 🔴; budżet wyczerpany → 🔴", () => {
    const ten = Array.from({length: 10}, () => ({sessionId: "s", slot: "H1", type: "regular", status: "active", valuePln: 35}));
    expect(sessionMoney(ten, 350)).toEqual({entries: 10, valuePln: 350, costPln: 350, resultPln: 0});
    expect(sessionLight(0, 0, FV)).toBe("green");
    expect(sessionLight(-105, 0, FV)).toBe("yellow");
    expect(sessionLight(-106, 0, FV)).toBe("red");
    expect(sessionLight(-50, -1960, FV)).toBe("red");
    expect(sessionLight(-50, -1950, FV)).toBe("yellow");
  });

  it("12 zapisów z karnetu 10 (24,50 zł) mieści się w limicie straty", () => {
    expect(sessionLight(12 * 24.5 - 350, 0, FV)).toBe("yellow");
  });
});

// ─── Firestore: zapis, lista rezerwowa, limit, odwołanie, decyzja ─────────────

// Dziś 23:00 — moment decyzji (30 h wcześniej) zawsze już minął, niezależnie od godziny testu.
function tomorrow(): string {
  return warsawTodayIso();
}

function session(date: string, over: any = {}) {
  return {
    _docId: date, id: date, date, notes: "", costPln: 350,
    slots: {
      H1: {timeStart: "23:00", timeEnd: "23:00", capacity: 2, enrolledCount: 0, status: "open"},
      H2: {timeStart: "23:45", timeEnd: "23:45", capacity: 2, enrolledCount: 0, status: "open"},
    },
    ...over,
  };
}

function credit(uid: string, n: number, price = 35) {
  return {uid, type: "admin_add", amount: n, unitPricePln: price, createdAt: new Date("2026-10-01")};
}

async function enroll(db: any, sessionId: string, uid: string, slot: "H1" | "H2" = "H1") {
  return enrollInSlot(db, {sessionId, slot, uid, email: `${uid}@x.pl`, displayName: uid, mode: "regular", isKursant: false, vars: await getBasenVars(db)});
}

describe("lista rezerwowa i spóźniona rezygnacja", () => {
  it("spóźniona rezygnacja: miejsce przejmuje 1. osoba z listy (płaci wejściem), rezygnujący dostaje zwrot", async () => {
    const d = tomorrow(); // po decyzji (30 h) = rezygnacja spóźniona
    const fake = new FakeFirestore({
      basen_sessions: [session(d)],
      basen_godziny_ledger: [credit("a", 1), credit("b", 1), credit("c", 1, 28)],
    });
    const db = fake.asDb();
    await enroll(db, d, "a");
    await enroll(db, d, "b");
    await expect(enroll(db, d, "c")).rejects.toThrow(/listę rezerwową/);
    await joinWaitlist(db, {sessionId: d, slot: "H1", uid: "c", email: "c@x.pl", displayName: "c", isKursant: false, vars: await getBasenVars(db)});

    const res = await cancelEnrollment(db, {sessionId: d, slot: "H1", uid: "a", cancellationWindowHours: 30, vars: await getBasenVars(db)});
    expect(res).toEqual({wasLate: true, refunded: true, promotedUid: "c"});

    const c = (await db.collection("basen_enrollments").doc(`${d}_H1_c`).get()).data() as any;
    expect(c).toMatchObject({status: "active", fromWaitlist: true, valuePln: 28});
    const a = (await db.collection("basen_enrollments").doc(`${d}_H1_a`).get()).data() as any;
    expect(a).toMatchObject({status: "cancelled", cancelledLate: true, lateRefunded: true});
    const s = (await db.collection("basen_sessions").doc(d).get()).data() as any;
    expect(s.slots.H1.enrolledCount).toBe(2); // miejsce przejęte, licznik bez zmian
    expect((await db.collection("basen_waitlist").doc(`${d}_H1_c`).get()).data()?.status).toBe("promoted");
    const jobs = (await db.collection("service_jobs").get()).docs.map((x: any) => x.data().taskId);
    expect(jobs).toContain("basen.notifyWaitlistPromoted");
  });

  it("spóźniona rezygnacja bez listy rezerwowej: wejście przepada (zostaje w wyniku terminu)", async () => {
    const d = tomorrow();
    const db = new FakeFirestore({basen_sessions: [session(d)], basen_godziny_ledger: [credit("a", 1)]}).asDb();
    await enroll(db, d, "a");
    const res = await cancelEnrollment(db, {sessionId: d, slot: "H1", uid: "a", cancellationWindowHours: 30, vars: await getBasenVars(db)});
    expect(res).toEqual({wasLate: true, refunded: false, promotedUid: null});
  });

  it("odwołanie terminu zwraca wejścia także spóźnionym rezygnacjom i zamyka listę rezerwową", async () => {
    const d = tomorrow();
    const db = new FakeFirestore({basen_sessions: [session(d)], basen_godziny_ledger: [credit("a", 1), credit("b", 1), credit("c", 1)]}).asDb();
    await enroll(db, d, "a");
    await enroll(db, d, "b");
    await joinWaitlist(db, {sessionId: d, slot: "H1", uid: "c", email: "c@x.pl", displayName: "c", isKursant: false, vars: await getBasenVars(db)});
    await enroll(db, d, "c", "H2");
    await cancelEnrollment(db, {sessionId: d, slot: "H2", uid: "c", cancellationWindowHours: 30, vars: await getBasenVars(db)});
    await cancelSession(db, d, "admin-uid", "frekwencja");

    const ledger = (await db.collection("basen_godziny_ledger").get()).docs.map((x: any) => x.data());
    const balance = (uid: string) => ledger.filter((r: any) => r.uid === uid).reduce((s: number, r: any) => s + r.amount, 0);
    expect([balance("a"), balance("b"), balance("c")]).toEqual([1, 1, 1]);
    const s = (await db.collection("basen_sessions").doc(d).get()).data() as any;
    expect(s.cancelReason).toBe("frekwencja");
    expect((await db.collection("basen_waitlist").doc(`${d}_H1_c`).get()).data()?.status).toBe("cancelled");
  });
});

describe("limit terminów naprzód (regulamin § 4 pkt 2)", () => {
  it("piąty termin odrzucony; druga godzina tego samego terminu dozwolona", async () => {
    const days = [2, 3, 4, 5, 6].map((n) => addDaysIso(warsawTodayIso(), n));
    const db = new FakeFirestore({basen_sessions: days.map((d) => session(d)), basen_godziny_ledger: [credit("a", 10)]}).asDb();
    for (const d of days.slice(0, 4)) await enroll(db, d, "a");
    await enroll(db, days[0], "a", "H2");
    await expect(enroll(db, days[4], "a")).rejects.toThrow(/najwyżej 4 terminy/);
  });
});

describe("decyzja o terminie (basen.decideSessions)", () => {
  const ctx = (db: any) => ({firestore: db, now: new Date(), dryRun: false, logger: {info: () => undefined, warn: () => undefined, error: () => undefined}} as any);

  it("za mało zapisów → odwołany z powodem 'frekwencja' i mailem; dość zapisów → potwierdzony", async () => {
    const d1 = tomorrow();
    const d2 = addDaysIso(d1, 0);
    const db = new FakeFirestore({
      basen_sessions: [session(d1, {slots: {
        H1: {timeStart: "23:00", timeEnd: "23:00", capacity: 10, enrolledCount: 0, status: "open"},
        H2: {timeStart: "23:45", timeEnd: "23:45", capacity: 10, enrolledCount: 0, status: "open"},
      }})],
      basen_godziny_ledger: ["a", "b", "c"].map((u) => credit(u, 1)),
    }).asDb();
    for (const u of ["a", "b", "c"]) await enroll(db, d1, u);
    const r = await basenDecideSessionsTask.run({} as any, ctx(db));
    expect(r.details).toMatchObject({cancelled: [d2], confirmed: []});
    const s = (await db.collection("basen_sessions").doc(d1).get()).data() as any;
    expect(s).toMatchObject({cancelReason: "frekwencja", decision: {status: "cancelled", zapisy: 3, resultPln: -245, light: "red"}});
    const jobs = (await db.collection("service_jobs").get()).docs.map((x: any) => x.data().taskId);
    expect(jobs).toContain("basen.notifySessionCancelled");
  });

  it("10 wejść jednorazowych (wynik 0) → potwierdzony; termin kursowy zawsze rusza", async () => {
    const d = tomorrow();
    const users = Array.from({length: 10}, (_, i) => `u${i}`);
    const db = new FakeFirestore({
      basen_sessions: [session(d, {slots: {
        H1: {timeStart: "23:00", timeEnd: "23:00", capacity: 10, enrolledCount: 0, status: "open"},
        H2: {timeStart: "23:45", timeEnd: "23:45", capacity: 10, enrolledCount: 0, status: "open"},
      }}), session(addDaysIso(d, 1), {slots: {
        H1: {timeStart: "00:30", timeEnd: "00:30", capacity: 10, enrolledCount: 0, status: "open", reservedSpots: {count: 5, restrictedToKursant: true, usedCount: 0}},
      }})],
      basen_godziny_ledger: users.map((u) => credit(u, 1)),
    }).asDb();
    for (const u of users) await enroll(db, d, u, u < "u5" ? "H1" : "H2");
    const r = await basenDecideSessionsTask.run({} as any, ctx(db));
    expect((r.details as any).confirmed.sort()).toEqual([d, addDaysIso(d, 1)].sort());
  });

  it("sezon: wynik netto z odbytych/potwierdzonych, odwołane poza wynikiem", () => {
    const vars: any = {basen_koszt_terminu: 350, basen_max_strata_terminu: 105, basen_budzet_sezonu: 2000, basen_okno_anulowania_h: 30};
    const mk = (date: string, over: any = {}) => ({...session(date), ...over});
    const e = (sid: string, n: number) => Array.from({length: n}, () => ({sessionId: sid, slot: "H1", type: "regular", status: "active", valuePln: 35}));
    const sessions: any[] = [
      mk("2026-11-02"),
      mk("2026-11-04", {slots: {H1: {timeStart: "21:00", status: "cancelled"}}, cancelReason: "frekwencja", decision: {zapisy: 4}}),
      mk("2026-11-09"),
    ];
    const {rows, summary} = computeSeason(sessions, [...e("2026-11-02", 12), ...e("2026-11-09", 7)] as any, vars, "2026-11-05");
    expect(rows.map((r) => r.outcome)).toEqual(["held", "cancelled", "planned"]);
    expect(summary).toMatchObject({netPln: 70, held: 1, cancelledLow: 1, planned: 1, budgetLeftPln: 2070});
    expect(rows[1].zapisy).toBe(4);
    expect(rows[2]).toMatchObject({resultPln: -105, light: "yellow"});
  });
});
