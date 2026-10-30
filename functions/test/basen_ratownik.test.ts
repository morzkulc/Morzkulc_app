/**
 * Ratownik terminu (opiekun basenu): zapis bez godziny basenowej, jeden na termin,
 * zajmuje miejsce; po odbytym terminie 1 godzinka klubowa (godzinki_ledger) — kod
 * PRODUKCYJNY na fake Firestore.
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {cancelEnrollment, enrollInSlot, getBasenVars} from "../src/modules/basen/basen_service";
import {computeBasenGodzinyBalance, getBasenGodzinyRecords} from "../src/modules/basen/basen_godziny_service";
import {warsawTodayIso, addDaysIso} from "../src/modules/basen/basen_finance";
import {basenGrantInstructorRewardsTask} from "../src/service/tasks/basenGrantInstructorRewards";

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

const ctx = (db: any) => ({firestore: db, now: new Date(), dryRun: false, logger: {info: () => undefined, warn: () => undefined, error: () => undefined}} as any);

async function ratownik(db: any, d: string, uid: string, slot: "H1" | "H2" = "H1") {
  return enrollInSlot(db, {sessionId: d, slot, uid, email: `${uid}@x.pl`, displayName: `${uid} R`, mode: "regular", ratownik: true, isKursant: false, vars: await getBasenVars(db)});
}

describe("ratownik terminu", () => {
  it("zapis bez godziny basenowej: zajmuje miejsce, bez blokady salda, ratownik na terminie", async () => {
    const d = warsawTodayIso();
    const fake = new FakeFirestore({basen_sessions: [session(d)]});
    const db = fake.asDb();
    await ratownik(db, d, "K");
    const s = (await db.collection("basen_sessions").doc(d).get()).data() as any;
    expect(s).toMatchObject({ratownikUid: "K", ratownikName: "K R"});
    expect(s.slots.H1.enrolledCount).toBe(1);
    const e = (await db.collection("basen_enrollments").doc(`${d}_H1_K`).get()).data() as any;
    expect(e).toMatchObject({type: "regular", ratownik: true, chargedGodziny: false, valuePln: 0, status: "active"});
    expect(computeBasenGodzinyBalance(await getBasenGodzinyRecords(db, "K"))).toBe(0);
  });

  it("jeden ratownik na termin (także na drugiej godzinie); rezygnacja zwalnia rolę bez zwrotu", async () => {
    const d = warsawTodayIso();
    const db = new FakeFirestore({basen_sessions: [session(d)]}).asDb();
    await ratownik(db, d, "K");
    await expect(ratownik(db, d, "J", "H2")).rejects.toThrow(/ma już ratownika: K R/);
    const r = await cancelEnrollment(db, {sessionId: d, slot: "H1", uid: "K", cancellationWindowHours: 30, vars: await getBasenVars(db)});
    expect(r.refunded).toBe(false);
    expect((await db.collection("basen_sessions").doc(d).get()).data()).toMatchObject({ratownikUid: null});
    await ratownik(db, d, "J", "H2");
    expect((await db.collection("basen_sessions").doc(d).get()).data()).toMatchObject({ratownikUid: "J"});
  });

  it("po odbytym terminie 1 godzinka klubowa, jednorazowo; odwołany termin bez nagrody", async () => {
    const past = addDaysIso(warsawTodayIso(), -2);
    const cancelledDay = addDaysIso(warsawTodayIso(), -3);
    const fake = new FakeFirestore({
      basen_sessions: [
        session(past, {ratownikUid: "K", ratownikName: "K R"}),
        session(cancelledDay, {ratownikUid: "K", ratownikName: "K R", slots: {
          H1: {timeStart: "23:00", timeEnd: "23:00", capacity: 2, enrolledCount: 0, status: "cancelled"},
          H2: {timeStart: "23:45", timeEnd: "23:45", capacity: 2, enrolledCount: 0, status: "cancelled"},
        }}),
      ],
      basen_enrollments: [
        {_docId: `${past}_H1_K`, id: `${past}_H1_K`, sessionId: past, slot: "H1", userUid: "K", type: "regular", ratownik: true, status: "active"},
        {_docId: `${cancelledDay}_H1_K`, id: `${cancelledDay}_H1_K`, sessionId: cancelledDay, slot: "H1", userUid: "K", type: "regular", ratownik: true, status: "active"},
      ],
    });
    const db = fake.asDb();
    await basenGrantInstructorRewardsTask.run({} as any, ctx(db));
    await basenGrantInstructorRewardsTask.run({} as any, ctx(db));
    const earn = fake.dump("godzinki_ledger");
    expect(earn).toHaveLength(1);
    expect(earn[0]).toMatchObject({uid: "K", type: "earn", amount: 1, remaining: 1, approved: true, reason: `Ratownik na basenie ${past}`});
    expect(fake.dump("basen_godziny_ledger")).toEqual([]); // to godzinka klubowa, nie godzina basenowa
  });
});
