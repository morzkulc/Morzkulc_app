/**
 * Ekstra godziny basenowe dopisane ręcznie przez opiekuna basenu (zastępuje dawnego „ratownika”) —
 * kod PRODUKCYJNY na fake Firestore. Nigdy nie dotyka godzinek klubowych.
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {addManualExtraBasenGodziny, manualExtraReason, computeBasenGodzinyBalance, getBasenGodzinyRecords} from "../src/modules/basen/basen_godziny_service";
import {nextEntryValuePln} from "../src/modules/basen/basen_finance";

describe("ekstra godziny basenowe", () => {
  it("opis wpisu w historii", () => {
    expect(manualExtraReason(1, "")).toBe("Ręczne dodanie 1 godziny basenowej");
    expect(manualExtraReason(3, "")).toBe("Ręczne dodanie 3 godzin basenowych");
    expect(manualExtraReason(2, "ratownik 12.11")).toBe("Ręczne dodanie 2 godzin basenowych — ratownik 12.11");
  });

  it("wpis manual_extra na saldzie basenowym, wartość 0 zł, bez godzinek klubowych", async () => {
    const db = new FakeFirestore({}).asDb();
    await addManualExtraBasenGodziny(db, {uid: "U", amount: 3, note: "", performedBy: "ADMIN"});
    const records = await getBasenGodzinyRecords(db, "U");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({type: "manual_extra", amount: 3, unitPricePln: 0, performedBy: "ADMIN", reason: "Ręczne dodanie 3 godzin basenowych"});
    expect(computeBasenGodzinyBalance(records)).toBe(3);
    expect(nextEntryValuePln(records as any, 35)).toBe(0);
    expect((await db.collection("godzinki_ledger").get()).size).toBe(0);
  });
});
