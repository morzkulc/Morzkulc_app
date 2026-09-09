/**
 * Testy jednostkowe TS modułu Basen (0% pokrycia wg audytu 09.09, sekcja 4.4).
 * Wykonują PRODUKCYJNY kod basen_service.ts / basen_godziny_service.ts:
 *  - computeSlotAvailability — matematyka pul (ogólna, blokada, pula kursancka),
 *  - sessionSlotDatetimeMs, parseVarValue, getBasenVars (klucze arkusza z polskimi znakami),
 *  - computeBasenGodzinyBalance,
 *  - ClientError (Faza 2: rozróżnienie 400/500 po typie, nie po treści komunikatu).
 *
 * Uruchamianie: npm --prefix functions run test
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {
  ClientError,
  computeSlotAvailability,
  sessionSlotDatetimeMs,
  parseVarValue,
  getBasenVars,
  BasenSlot,
} from "../src/modules/basen/basen_service";
import {computeBasenGodzinyBalance, BasenGodzinyRecord} from "../src/modules/basen/basen_godziny_service";

function slot(o: Partial<BasenSlot> = {}): BasenSlot {
  return {timeStart: "19:00", timeEnd: "20:00", capacity: 15, enrolledCount: 0, status: "open", ...o};
}

describe("computeSlotAvailability — slot bez reservedSpots", () => {
  it("remaining = capacity − enrolledCount, tak samo dla kursanta i członka", () => {
    const s = slot({enrolledCount: 3});
    expect(computeSlotAvailability(s, false)).toEqual({remaining: 12, isFull: false, viaReservedPool: false, generalCapacity: 15, generalRemaining: 12});
    expect(computeSlotAvailability(s, true)).toEqual({remaining: 12, isFull: false, viaReservedPool: false, generalCapacity: 15, generalRemaining: 12});
  });

  it("pełny slot: enrolledCount == capacity → isFull; nadmiar clampowany do 0", () => {
    expect(computeSlotAvailability(slot({enrolledCount: 15}), false)).toMatchObject({remaining: 0, isFull: true});
    expect(computeSlotAvailability(slot({enrolledCount: 17}), false)).toMatchObject({remaining: 0, isFull: true, generalRemaining: 0});
  });
});

describe("computeSlotAvailability — blokada ogólna (restrictedToKursant=false)", () => {
  const s = slot({enrolledCount: 10, reservedSpots: {count: 5, restrictedToKursant: false, label: "grupa X", usedCount: 0}});

  it("zmniejsza pulę ogólną dla WSZYSTKICH (także kursanta) — 15 − 5 = 10 miejsc", () => {
    expect(computeSlotAvailability(s, false)).toEqual({remaining: 0, isFull: true, viaReservedPool: false, generalCapacity: 10, generalRemaining: 0});
    expect(computeSlotAvailability(s, true)).toEqual({remaining: 0, isFull: true, viaReservedPool: false, generalCapacity: 10, generalRemaining: 0});
  });

  it("blokada większa niż capacity → generalCapacity 0 (bez wartości ujemnych)", () => {
    const big = slot({capacity: 4, reservedSpots: {count: 9, restrictedToKursant: false, usedCount: 0}});
    expect(computeSlotAvailability(big, false)).toMatchObject({generalCapacity: 0, generalRemaining: 0, isFull: true});
  });
});

describe("computeSlotAvailability — pula kursancka (restrictedToKursant=true)", () => {
  const s = slot({enrolledCount: 2, reservedSpots: {count: 4, restrictedToKursant: true, usedCount: 1}});

  it("kursant rezerwuje WYŁĄCZNIE z własnej puli (count − usedCount), viaReservedPool=true", () => {
    expect(computeSlotAvailability(s, true)).toEqual({remaining: 3, isFull: false, viaReservedPool: true, generalCapacity: 11, generalRemaining: 9});
  });

  it("nie-kursant widzi pulę ogólną pomniejszoną o pulę kursancką", () => {
    expect(computeSlotAvailability(s, false)).toEqual({remaining: 9, isFull: false, viaReservedPool: false, generalCapacity: 11, generalRemaining: 9});
  });

  it("wyczerpana pula kursancka → kursant ma isFull mimo wolnych miejsc ogólnych; usedCount > count clampowany", () => {
    const full = slot({enrolledCount: 0, reservedSpots: {count: 4, restrictedToKursant: true, usedCount: 4}});
    expect(computeSlotAvailability(full, true)).toMatchObject({remaining: 0, isFull: true, viaReservedPool: true, generalRemaining: 11});
    expect(computeSlotAvailability(full, false)).toMatchObject({remaining: 11, isFull: false});
    const over = slot({reservedSpots: {count: 4, restrictedToKursant: true, usedCount: 6}});
    expect(computeSlotAvailability(over, true)).toMatchObject({remaining: 0, isFull: true});
  });

  it("wyczerpana pula ogólna nie blokuje kursanta z wolną pulą kursancką", () => {
    const s2 = slot({enrolledCount: 11, reservedSpots: {count: 4, restrictedToKursant: true, usedCount: 0}});
    expect(computeSlotAvailability(s2, false)).toMatchObject({remaining: 0, isFull: true});
    expect(computeSlotAvailability(s2, true)).toMatchObject({remaining: 4, isFull: false, viaReservedPool: true});
  });
});

describe("sessionSlotDatetimeMs", () => {
  it("łączy datę sesji z godziną slotu (czas lokalny), H1 < H2", () => {
    const h1 = sessionSlotDatetimeMs({date: "2026-09-10"}, {timeStart: "19:00"});
    const h2 = sessionSlotDatetimeMs({date: "2026-09-10"}, {timeStart: "21:00"});
    expect(h1).toBe(new Date("2026-09-10T19:00:00").getTime());
    expect(h2 - h1).toBe(2 * 3600 * 1000);
  });

  it("brak slotu / brak timeStart → 0", () => {
    expect(sessionSlotDatetimeMs({date: "2026-09-10"}, undefined)).toBe(0);
    expect(sessionSlotDatetimeMs({date: "2026-09-10"}, null)).toBe(0);
    expect(sessionSlotDatetimeMs({date: "2026-09-10"}, {timeStart: ""})).toBe(0);
  });
});

describe("parseVarValue", () => {
  it("null/undefined → null; {value} → value (także null); prymitywy bez zmian", () => {
    expect(parseVarValue(null)).toBeNull();
    expect(parseVarValue(undefined)).toBeNull();
    expect(parseVarValue({value: 5})).toBe(5);
    expect(parseVarValue({value: null})).toBeNull();
    expect(parseVarValue(7)).toBe(7);
    expect(parseVarValue("x")).toBe("x");
    expect(parseVarValue(false)).toBe(false);
  });

  it("obiekt bez pola value zwracany bez zmian", () => {
    const o = {foo: 1};
    expect(parseVarValue(o)).toBe(o);
  });
});

describe("getBasenVars — setup/vars_basen", () => {
  it("brak dokumentu → wartości domyślne", async () => {
    const v = await getBasenVars(new FakeFirestore().asDb());
    expect(v).toEqual({
      basen_admin_mail: [],
      basen_limit_uczestnikow: 15,
      basen_1_godzina_domyslna: "19:00",
      basen_2_godzina_domyslna: "21:00",
      basen_sauna: false,
      basen_sauna_cena: 0,
      basen_okno_anulowania_h: 24,
      basen_cena_za_godzine: 0,
      basen_cena_za_karnet: 0,
      basen_ile_wejsc_na_karnet: 0,
    });
  });

  it("czyta klucze arkusza z polskimi znakami i historyczną nazwą okna anulowania; maile rozdziela i normalizuje", async () => {
    const db = new FakeFirestore({setup: [{
      _docId: "vars_basen",
      vars: {
        "basen_admin_mail": {value: " Ala@X.pl, b@y.pl ,,"},
        "basen_limit_uczestników": {value: "12"},
        "basen_1_godzina_domyslna": {value: "18:30"},
        "basen_sauna": {value: true},
        "basen_sauna_cena": {value: 15},
        "basen_rezygnacja_za_darmo": {value: 12},
        "basen_cena_za_godzine": {value: 30},
        "basen_cena_za_karnet": {value: 250},
        "basen_ile_wejść_na_karnet": {value: 10},
      },
    }]}).asDb();
    const v = await getBasenVars(db);
    expect(v).toMatchObject({
      basen_admin_mail: ["ala@x.pl", "b@y.pl"],
      basen_limit_uczestnikow: 12,
      basen_1_godzina_domyslna: "18:30",
      basen_2_godzina_domyslna: "21:00",
      basen_sauna: true,
      basen_sauna_cena: 15,
      basen_okno_anulowania_h: 12,
      basen_cena_za_godzine: 30,
      basen_cena_za_karnet: 250,
      basen_ile_wejsc_na_karnet: 10,
    });
  });

  it("klucz bez polskich znaków (basen_limit_uczestnikow) NIE jest czytany — kod dostosowany do arkusza", async () => {
    const db = new FakeFirestore({setup: [{_docId: "vars_basen", vars: {"basen_limit_uczestnikow": {value: 12}}}]}).asDb();
    expect((await getBasenVars(db)).basen_limit_uczestnikow).toBe(15);
  });
});

describe("computeBasenGodzinyBalance", () => {
  const rec = (type: BasenGodzinyRecord["type"], amount: any): BasenGodzinyRecord =>
    ({id: "x", uid: "u", type, amount, reason: "", performedBy: "u", createdAt: null as any, updatedAt: null as any});

  it("pusty ledger → 0; suma kredytów i debetów", () => {
    expect(computeBasenGodzinyBalance([])).toBe(0);
    expect(computeBasenGodzinyBalance([rec("admin_add", 10), rec("booking_block", -1), rec("booking_refund", 1), rec("instructor_reward", 1)])).toBe(11);
  });

  it("string liczbowy sumowany, brak amount jako 0", () => {
    expect(computeBasenGodzinyBalance([rec("admin_add", "2"), rec("booking_block", undefined), rec("booking_refund", null)])).toBe(2);
  });

  it("nienumeryczny amount (np. ręczna edycja w konsoli) liczony jako 0 — saldo nigdy nie jest NaN", () => {
    expect(computeBasenGodzinyBalance([rec("admin_add", 10), rec("booking_block", "abc"), rec("booking_block", NaN), rec("booking_block", {})])).toBe(10);
  });
});

describe("ClientError — rozróżnienie 400/500", () => {
  it("jest instancją Error i ClientError, z nazwą ClientError i komunikatem", () => {
    const e = new ClientError("Slot jest pełny.");
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ClientError);
    expect(e.name).toBe("ClientError");
    expect(e.message).toBe("Slot jest pełny.");
  });

  it("zwykły Error z identyczną treścią NIE jest ClientError (treść komunikatu nie decyduje)", () => {
    expect(new Error("Slot jest pełny.")).not.toBeInstanceOf(ClientError);
  });
});
