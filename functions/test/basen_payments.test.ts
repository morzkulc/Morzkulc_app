/**
 * Rozliczenie z basenem (24.11.2026): faktura wystawiona / zapłacono gotówką (data) / cofnij.
 * Tylko odbyte, nieodwołane terminy; bez kwot i numerów faktur.
 */
import {describe, it, expect} from "vitest";
import {parsePaymentInput, setSessionsPayment} from "../src/modules/basen/basen_payments";
import {FakeFirestore} from "./helpers/fake_firestore";

const slotOk = {H1: {status: "open"}};
const slotCancelled = {H1: {status: "cancelled"}, H2: {status: "cancelled"}};

function seed() {
  return new FakeFirestore({
    basen_sessions: [
      {_docId: "2026-11-05", date: "2026-11-05", slots: slotOk},
      {_docId: "2026-11-12", date: "2026-11-12", slots: slotOk},
      {_docId: "2026-11-19", date: "2026-11-19", slots: slotCancelled},
      {_docId: "2026-11-26", date: "2026-11-26", slots: slotOk},
    ],
  });
}

describe("parsePaymentInput", () => {
  it("cash wymaga daty, nie z przyszłości", () => {
    expect(() => parsePaymentInput({sessionIds: ["a"], status: "cash"}, "2026-11-24")).toThrow("datę");
    expect(() => parsePaymentInput({sessionIds: ["a"], status: "cash", date: "2026-11-25"}, "2026-11-24")).toThrow("przyszłości");
    expect(parsePaymentInput({sessionIds: ["a", "a"], status: "cash", date: "2026-11-20"}, "2026-11-24"))
      .toEqual({sessionIds: ["a"], status: "cash", date: "2026-11-20"});
  });
  it("invoice bez daty; brak terminów i zły status → błąd", () => {
    expect(parsePaymentInput({sessionIds: ["a"], status: "invoice", date: "x"}).date).toBeNull();
    expect(() => parsePaymentInput({sessionIds: [], status: "invoice"})).toThrow("Zaznacz");
    expect(() => parsePaymentInput({sessionIds: ["a"], status: "paid"})).toThrow("status");
  });
});

describe("setSessionsPayment", () => {
  it("faktura → gotówka → cofnięcie na odbytych terminach", async () => {
    const fs = seed();
    const db = fs.asDb() as any;
    await setSessionsPayment(db, {sessionIds: ["2026-11-05", "2026-11-12"], status: "invoice", date: null, markedBy: "u1", today: "2026-11-24"});
    expect(fs.store("basen_sessions").get("2026-11-05")?.payment).toMatchObject({status: "invoice", date: null, markedBy: "u1"});

    await setSessionsPayment(db, {sessionIds: ["2026-11-12"], status: "cash", date: "2026-11-20", markedBy: "u2", today: "2026-11-24"});
    expect(fs.store("basen_sessions").get("2026-11-12")?.payment).toMatchObject({status: "cash", date: "2026-11-20", markedBy: "u2"});

    await setSessionsPayment(db, {sessionIds: ["2026-11-05"], status: "none", date: null, markedBy: "u1", today: "2026-11-24"});
    expect(fs.store("basen_sessions").get("2026-11-05")?.payment).toBeUndefined();
  });

  it("odwołany albo przyszły termin → błąd i nic nie zapisane (cała paczka)", async () => {
    const fs = seed();
    const db = fs.asDb() as any;
    await expect(setSessionsPayment(db, {sessionIds: ["2026-11-05", "2026-11-19"], status: "invoice", date: null, markedBy: "u1", today: "2026-11-24"}))
      .rejects.toThrow("odwołany");
    await expect(setSessionsPayment(db, {sessionIds: ["2026-11-26"], status: "invoice", date: null, markedBy: "u1", today: "2026-11-24"}))
      .rejects.toThrow("nie odbył");
    expect(fs.store("basen_sessions").get("2026-11-05")?.payment).toBeUndefined();
  });
});
