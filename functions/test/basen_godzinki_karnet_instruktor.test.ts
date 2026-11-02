/**
 * Godzinki społeczne w basenie (regulamin § 3 i § 6) — kod PRODUKCYJNY na fake Firestore:
 * karnet = dofinansowanie (saldo godzinek wypracowanych ≥ koszt, zdejmowane przy zatwierdzeniu),
 * instruktor = zasób klubowy (1 godzinka za godzinę z debetem; sympatyk — dodatkowa godzina basenowa; kursant za darmo).
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore, ts} from "./helpers/fake_firestore";
import {approveOrder, createOrder, getKarnetEligibility} from "../src/modules/basen/basen_orders";
import {computeBalance, computeEarnedBalance, getAllRecords} from "../src/modules/hours/godzinki_service";
import {precheckInstructorCharge, syncInstructorCharge} from "../src/modules/basen/basen_instructor_charge";
import {addDaysIso, warsawTodayIso} from "../src/modules/basen/basen_finance";
import {computeBasenGodzinyBalance, getBasenGodzinyRecords} from "../src/modules/basen/basen_godziny_service";

const PRICING = {basen_cena_za_godzine: 35, basen_cena_karnet_5: 140, basen_cena_karnet_10: 245};

function earn(uid: string, amount: number, id = `earn-${uid}`) {
  return {_docId: id, id, uid, type: "earn", amount, remaining: amount, approved: true,
    grantedAt: ts("2026-01-01T00:00:00Z"), expiresAt: ts("2030-01-01T00:00:00Z"), reason: "seed", submittedBy: uid};
}

function user(id: string, roleKey: string) {
  return {_docId: id, role_key: roleKey, status_key: "status_aktywny", email: `${id.toLowerCase()}@x.pl`,
    profile: {firstName: id, lastName: "Test"}, admin: {contributions: "2099-12-31"}};
}

async function data(db: any, uid: string) {
  return (await db.collection("users_active").doc(uid).get()).data();
}

// Koniec sezonu basenowego tylko z SETUP — bez niego karnet jest niedostępny.
const SEASON = {_docId: "vars_basen", vars: {basen_koniec_sezonu: {value: "2099-04-15"}}};

describe("karnet — dofinansowanie za godzinki", () => {
  it("dostępność wg kosztu karnetu (3 / 5) i salda wypracowanego", async () => {
    const db = new FakeFirestore({users_active: [user("A", "rola_czlonek")], godzinki_ledger: [earn("A", 4)], setup: [SEASON]}).asDb();
    const el = await getKarnetEligibility(db, "A", await data(db, "A"));
    expect(el).toMatchObject({byProduct: {karnet5: true, karnet10: false}, godzinkiCost: {karnet5: 3, karnet10: 5}, godzinkiBalance: 4});
  });

  it("godzinki wykupione spłacają debet, ale nie robią plusa", async () => {
    const records: any[] = [
      {type: "spend", overdraft: 3, amount: 3},
      {type: "purchase", amount: 10, approved: true},
    ];
    expect(computeBalance(records)).toBe(7);
    expect(computeEarnedBalance(records)).toBe(0);
  });

  it("zatwierdzenie karnetu 10 zdejmuje 5 godzinek; gdy saldo spadło poniżej kosztu — odmowa", async () => {
    const db = new FakeFirestore({users_active: [user("A", "rola_czlonek"), user("B", "rola_czlonek")],
      godzinki_ledger: [earn("A", 5), earn("B", 5)], setup: [SEASON]}).asDb();
    const oA = await createOrder(db, {uid: "A", userData: await data(db, "A"), userName: "A", product: "karnet10", count: undefined, pricing: PRICING});
    await approveOrder(db, {orderId: oA.id, performedBy: "ADMIN"});
    const recA = await getAllRecords(db, "A");
    expect(computeBalance(recA)).toBe(0);
    expect(recA.find((r) => r.type === "spend")?.reservationId).toMatch(/^basen_karnet_/);

    const oB = await createOrder(db, {uid: "B", userData: await data(db, "B"), userName: "B", product: "karnet10", count: undefined, pricing: PRICING});
    await db.collection("godzinki_ledger").doc("earn-B").update({remaining: 4});
    await expect(approveOrder(db, {orderId: oB.id, performedBy: "ADMIN"})).rejects.toThrow(/5 godzinek wypracowanych/);
  });
});

describe("instruktor — 1 godzinka społeczna za godzinę", () => {
  const d = addDaysIso(warsawTodayIso(), 3);
  const session = {_docId: d, id: d, date: d, slots: {H1: {timeStart: "21:00", timeEnd: "21:45", capacity: 10, enrolledCount: 1, status: "open"}}};
  const instr = {_docId: `${d}_H1_I`, id: `${d}_H1_I`, sessionId: d, slot: "H1", userUid: "I", type: "instructor", status: "active"};
  const student = (uid: string, over: any = {}) => ({_docId: `${d}_H1_${uid}`, id: `${d}_H1_${uid}`, sessionId: d, slot: "H1",
    userUid: uid, type: "training", instructorUid: "I", status: "active", ...over});
  const balance = async (db: any, uid: string) => computeBalance(await getAllRecords(db, uid));

  it("pobiera raz (debet dozwolony), oddaje gdy instruktor się wypisze", async () => {
    const db = new FakeFirestore({users_active: [user("S", "rola_czlonek")], basen_sessions: [session],
      basen_enrollments: [instr, student("S")]}).asDb();
    expect(await syncInstructorCharge(db, `${d}_H1_S`)).toBe("charged");
    expect(await syncInstructorCharge(db, `${d}_H1_S`)).toBe("none");
    expect(await balance(db, "S")).toBe(-1);
    await db.collection("basen_enrollments").doc(`${d}_H1_I`).update({status: "cancelled"});
    expect(await syncInstructorCharge(db, `${d}_H1_S`)).toBe("refunded");
    expect(await balance(db, "S")).toBe(0);
  });

  it("spóźniona rezygnacja: przepada; odwołanie terminu przez Klub: wraca", async () => {
    const db = new FakeFirestore({users_active: [user("S", "rola_czlonek")], basen_sessions: [session],
      basen_enrollments: [instr, student("S")], godzinki_ledger: [earn("S", 2)]}).asDb();
    await syncInstructorCharge(db, `${d}_H1_S`);
    await db.collection("basen_enrollments").doc(`${d}_H1_S`).update({status: "cancelled", cancelledLate: true});
    expect(await syncInstructorCharge(db, `${d}_H1_S`)).toBe("none");
    expect(await balance(db, "S")).toBe(1);
    await db.collection("basen_sessions").doc(d).update({"slots.H1.status": "cancelled"});
    expect(await syncInstructorCharge(db, `${d}_H1_S`)).toBe("refunded");
    expect(await balance(db, "S")).toBe(2);
  });

  it("rezygnacja na czas oddaje godzinkę", async () => {
    const db = new FakeFirestore({users_active: [user("S", "rola_czlonek")], basen_sessions: [session],
      basen_enrollments: [instr, student("S")]}).asDb();
    await syncInstructorCharge(db, `${d}_H1_S`);
    await db.collection("basen_enrollments").doc(`${d}_H1_S`).update({status: "cancelled", cancelledLate: false});
    expect(await syncInstructorCharge(db, `${d}_H1_S`)).toBe("refunded");
    expect(await balance(db, "S")).toBe(0);
  });

  it("sympatyk płaci dodatkową godziną basenową (bez godzinek), zwrot po wypisaniu instruktora; kursant za darmo", async () => {
    const basenAdd = {_docId: "ba", id: "ba", uid: "Y", type: "admin_add", amount: 2, unitPricePln: 35};
    const db = new FakeFirestore({users_active: [user("Y", "rola_sympatyk"), user("K", "rola_kursant")], basen_sessions: [session],
      basen_enrollments: [instr, student("Y"), student("K")], basen_godziny_ledger: [basenAdd]}).asDb();
    const basenBal = async () => computeBasenGodzinyBalance(await getBasenGodzinyRecords(db, "Y"));
    expect(await syncInstructorCharge(db, `${d}_H1_Y`)).toBe("charged");
    expect(await syncInstructorCharge(db, `${d}_H1_Y`)).toBe("none");
    expect(await basenBal()).toBe(1);
    expect((await getAllRecords(db, "Y")).length).toBe(0);
    await db.collection("basen_enrollments").doc(`${d}_H1_I`).update({status: "cancelled"});
    expect(await syncInstructorCharge(db, `${d}_H1_Y`)).toBe("refunded");
    expect(await basenBal()).toBe(2);
    expect(await syncInstructorCharge(db, `${d}_H1_K`)).toBe("none");
  });

  it("sympatyk bez 2 godzin basenowych nie zapisze się z instruktorem", async () => {
    const db = new FakeFirestore({users_active: [user("Y", "rola_sympatyk")],
      basen_godziny_ledger: [{_docId: "ba", id: "ba", uid: "Y", type: "admin_add", amount: 1, unitPricePln: 35}]}).asDb();
    await expect(precheckInstructorCharge(db, "Y", {enrolling: true})).rejects.toThrow(/potrzebujesz 2/);
    await expect(precheckInstructorCharge(db, "Y")).resolves.toBeUndefined();
  });

  it("limit debetu sprawdzany przed przypisaniem instruktora", async () => {
    const db = new FakeFirestore({users_active: [user("S", "rola_czlonek")],
      godzinki_ledger: [{_docId: "sp", id: "sp", uid: "S", type: "spend", amount: 20, overdraft: 20, fromEarn: 0}]}).asDb();
    await expect(precheckInstructorCharge(db, "S")).rejects.toThrow(/limit debetu/);
  });
});
