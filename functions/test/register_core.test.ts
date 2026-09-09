/**
 * Testy jednostkowe TS rejestracji / bootstrapu roli z bilansu otwarcia
 * (0% pokrycia wg audytu 09.09, sekcja 4.4; zmiana z Fazy 1: wspólny odczyt
 * users_opening_balance_26 dla findOpeningBalance + emailExistsInOtherObRow).
 * Wykonują PRODUKCYJNY kod registerUserHandler.ts / opening_balance_fields.ts.
 *
 * Uruchamianie: npm --prefix functions run test
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {computeRoleKeyFromOpeningBalance, findOpeningBalance, emailExistsInOtherObRow} from "../src/api/registerUserHandler";
import {
  normObKey,
  obValueByPrefix,
  obValueExact,
  obEmailKey,
  obBool,
  getObHours,
  buildOpeningBalanceAdminPatch,
} from "../src/modules/hours/opening_balance_fields";

const MEMBER_FIELD = "członek stowarzyszenia";

describe("computeRoleKeyFromOpeningBalance", () => {
  it("członek stowarzyszenia === true → rola członka; inaczej domyślna", () => {
    expect(computeRoleKeyFromOpeningBalance({[MEMBER_FIELD]: true}, MEMBER_FIELD, "rola_czlonek", "rola_sympatyk")).toBe("rola_czlonek");
    expect(computeRoleKeyFromOpeningBalance({[MEMBER_FIELD]: false}, MEMBER_FIELD, "rola_czlonek", "rola_sympatyk")).toBe("rola_sympatyk");
    expect(computeRoleKeyFromOpeningBalance({}, MEMBER_FIELD, "rola_czlonek", "rola_sympatyk")).toBe("rola_sympatyk");
    expect(computeRoleKeyFromOpeningBalance(null, MEMBER_FIELD, "rola_czlonek", "rola_sympatyk")).toBe("rola_sympatyk");
  });

  it("wartość tekstowa 'tak' NIE jest równoważna true (ścisłe porównanie)", () => {
    expect(computeRoleKeyFromOpeningBalance({[MEMBER_FIELD]: "tak"}, MEMBER_FIELD, "rola_czlonek", "rola_sympatyk")).toBe("rola_sympatyk");
  });
});

function obDb() {
  return new FakeFirestore({
    users_opening_balance_26: [
      {"_docId": "ob1", "E-mail": "Jan.Kowalski@X.pl", "Imię": "Jan", "Nazwisko": "Kowalski", "członek stowarzyszenia": true},
      {"_docId": "ob2", "e-mail": "", "Imię": "Anna", "Nazwisko": "Nowak"},
      {"_docId": "ob3", "email": "dup@x.pl", "Imię": "Jan", "Nazwisko": "Kowalski"},
    ],
  }).asDb();
}

describe("findOpeningBalance — dopasowanie wiersza bilansu otwarcia", () => {
  it("po e-mailu (priorytet), niewrażliwie na wielkość liter, nagłówek E-mail/e-mail/email", async () => {
    const m = await findOpeningBalance(obDb(), "jan.kowalski@x.pl");
    expect(m).toMatchObject({openingMatch: true, matchMethod: "email", obDocId: "ob1", obEmail: "jan.kowalski@x.pl"});
    expect(m.obData[MEMBER_FIELD]).toBe(true);
    expect(m.allDocs).toHaveLength(3);

    const m3 = await findOpeningBalance(obDb(), "DUP@x.pl", "Jan", "Kowalski");
    expect(m3).toMatchObject({matchMethod: "email", obDocId: "ob3"});
  });

  it("fallback po imieniu i nazwisku (niewrażliwie na wielkość liter), obEmail=null gdy wiersz bez maila", async () => {
    const m = await findOpeningBalance(obDb(), "nowa@x.pl", "ANNA", "nowak");
    expect(m).toMatchObject({openingMatch: true, matchMethod: "name", obDocId: "ob2", obEmail: null});
  });

  it("przy kilku wierszach o tym samym nazwisku wygrywa pierwszy", async () => {
    const m = await findOpeningBalance(obDb(), "inny@x.pl", "Jan", "Kowalski");
    expect(m).toMatchObject({matchMethod: "name", obDocId: "ob1"});
  });

  it("brak dopasowania → openingMatch=false, ale snapshot (allDocs) nadal dostępny (jeden odczyt kolekcji)", async () => {
    const m = await findOpeningBalance(obDb(), "nikt@x.pl", "Zenon", "Nikt");
    expect(m).toMatchObject({openingMatch: false, obData: null, matchMethod: null, obDocId: null, obEmail: null});
    expect(m.allDocs).toHaveLength(3);
  });

  it("e-mail bez '@' nie dopasowuje po mailu; bez imienia/nazwiska brak fallbacku", async () => {
    expect(await findOpeningBalance(obDb(), "jan.kowalski")).toMatchObject({openingMatch: false});
    expect(await findOpeningBalance(obDb(), "nikt@x.pl", "Jan")).toMatchObject({openingMatch: false});
  });

  it("pusta kolekcja → brak dopasowania, allDocs=[]", async () => {
    const m = await findOpeningBalance(new FakeFirestore().asDb(), "jan.kowalski@x.pl");
    expect(m).toMatchObject({openingMatch: false});
    expect(m.allDocs).toEqual([]);
  });
});

describe("emailExistsInOtherObRow — kolizja maila przy aktualizacji wiersza", () => {
  it("ten sam mail w innym wierszu → true; własny wiersz pomijany", async () => {
    const {allDocs} = await findOpeningBalance(obDb(), "x@x.pl");
    expect(await emailExistsInOtherObRow(allDocs, "dup@x.pl", "ob3")).toBe(false);
    expect(await emailExistsInOtherObRow(allDocs, "dup@x.pl", null)).toBe(true);
    expect(await emailExistsInOtherObRow(allDocs, "JAN.kowalski@x.pl", "ob2")).toBe(true);
  });

  it("pusty mail lub bez '@' → false", async () => {
    const {allDocs} = await findOpeningBalance(obDb(), "x@x.pl");
    expect(await emailExistsInOtherObRow(allDocs, "", null)).toBe(false);
    expect(await emailExistsInOtherObRow(allDocs, "dup", null)).toBe(false);
  });
});

describe("opening_balance_fields — helpery nagłówków bilansu", () => {
  it("normObKey: lowercase, bez spacji i kropek", () => {
    expect(normObKey("Nr leg.")).toBe("nrleg");
    expect(normObKey("  E-Mail ")).toBe("e-mail");
    expect(normObKey(null)).toBe("");
  });

  it("obValueByPrefix: dopasowanie po prefiksie znormalizowanego nagłówka", () => {
    expect(obValueByPrefix({"Składki 2026": "opłacone"}, "składki")).toBe("opłacone");
    expect(obValueByPrefix({"Składki 2026": "opłacone"}, "godzinki")).toBeUndefined();
    expect(obValueByPrefix(null, "składki")).toBeUndefined();
  });

  it("obValueExact: dokładne dopasowanie jednego z wariantów, bez dopasowania prefiksowego", () => {
    expect(obValueExact({"Nr leg": "12"}, "Nr leg.", "Nr leg")).toBe("12");
    expect(obValueExact({"nr leg.": "12"}, "Nr leg.")).toBe("12");
    expect(obValueExact({"Szkoleniówka 2": "x"}, "Szkoleniówka")).toBeUndefined();
  });

  it("obEmailKey: zwraca faktyczny klucz nagłówka maila (do aktualizacji)", () => {
    expect(obEmailKey({"Imię": "A", "E-mail": "a@x.pl"})).toBe("E-mail");
    expect(obEmailKey({"email": "a@x.pl"})).toBe("email");
    expect(obEmailKey({"Imię": "A"})).toBeNull();
    expect(obEmailKey(null)).toBeNull();
  });

  it("obBool: true / tak / true / 1 / ✓ → true; reszta → false", () => {
    for (const v of [true, "tak", " TAK ", "true", "1", "✓"]) expect(obBool(v)).toBe(true);
    for (const v of ["nie", "", null, undefined, 0, false, "0"]) expect(obBool(v)).toBe(false);
  });

  it("getObHours: pole z datą w nagłówku, wartości ujemne ZACHOWANE (bug z 31.07: ujemny bilans był gubiony)", () => {
    expect(getObHours({"Godzinki Bilans otwarcia01.04.2026": "14"})).toBe(14);
    expect(getObHours({"godzinki BO": -19})).toBe(-19);
    expect(getObHours({"Godzinki": "-10"})).toBe(-10);
    expect(getObHours({"Godzinki": "abc"})).toBe(0);
    expect(getObHours({"Inne": "5"})).toBe(0);
    expect(getObHours(null)).toBe(0);
  });

  it("buildOpeningBalanceAdminPatch: pełny wiersz → admin.* z przyciętymi wartościami; puste pomijane", () => {
    const patch = buildOpeningBalanceAdminPatch({
      "Składki 2026": " opłacone ",
      "Godzinki Bilans otwarcia01.04.2026": "14",
      "Szkoleniówka": "2024",
      "blacha": " 123 ",
      "Nr leg.": "7",
      "Uczelnia": "",
      "Funkcje pełnione na rzecz klubu": "skarbnik",
      "założyciel stowarzyszenia": "tak",
    });
    expect(patch).toEqual({
      contributions: "opłacone",
      hours: "14",
      schoolYear: "2024",
      badge: "123",
      legNr: "7",
      clubFunctions: "skarbnik",
      founder: true,
    });
  });

  it("buildOpeningBalanceAdminPatch: null → null; wiersz bez pól → tylko hours='0'; founder=false gdy pole obecne i puste", () => {
    expect(buildOpeningBalanceAdminPatch(null)).toBeNull();
    expect(buildOpeningBalanceAdminPatch({"Imię": "Jan"})).toEqual({hours: "0"});
    expect(buildOpeningBalanceAdminPatch({"założyciel stowarzyszenia": ""})).toEqual({hours: "0", founder: false});
  });
});
