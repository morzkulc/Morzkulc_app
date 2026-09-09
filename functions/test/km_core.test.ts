/**
 * Testy jednostkowe TS modułu Kilometrówka (0% pokrycia wg audytu 09.09, sekcja 4.4).
 * Wykonują PRODUKCYJNY kod km_scoring.ts / km_vars.ts / km_places_service.ts:
 *  - computePoints — punkty liczone ON WRITE (zaokrąglenia, wartości ujemne/ułamkowe),
 *  - getYearFromDate / getSeasonKeyFromDate,
 *  - getKmVars — odczyt setup/vars_kurs z fallbackami,
 *  - tokenizeName — tokeny do wyszukiwania akwenów (array-contains).
 *
 * Uruchamianie: npm --prefix functions run test
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {computePoints, getYearFromDate, getSeasonKeyFromDate} from "../src/modules/km/km_scoring";
import {getKmVars, KmVars} from "../src/modules/km/km_vars";
import {tokenizeName} from "../src/modules/km/km_places_service";

const VARS: KmVars = {ptsKabina: 1, ptsEskimoska: 0.5, ptsDziubek: 0.25, scoringVersion: "v1"};

describe("computePoints", () => {
  it("kabina·1 + rolka·0.5 + dziubek·0.25; breakdown == total; wersja punktacji przepisana", () => {
    expect(computePoints({kabina: 2, rolka: 1, dziubek: 1}, VARS)).toEqual({
      pointsTotal: 2.75,
      pointsBreakdown: {capsizeRolls: 2.75},
      scoringVersion: "v1",
    });
  });

  it("same zera → 0; wartości ujemne clampowane do 0", () => {
    expect(computePoints({kabina: 0, rolka: 0, dziubek: 0}, VARS).pointsTotal).toBe(0);
    expect(computePoints({kabina: -3, rolka: -1, dziubek: 4}, VARS).pointsTotal).toBe(1);
  });

  it("liczniki ułamkowe zaokrąglane do całości przed przeliczeniem (1.4→1, 1.5→2)", () => {
    expect(computePoints({kabina: 1.4, rolka: 0, dziubek: 0}, VARS).pointsTotal).toBe(1);
    expect(computePoints({kabina: 1.5, rolka: 0, dziubek: 0}, VARS).pointsTotal).toBe(2);
  });

  it("brakujące pola (undefined/NaN) traktowane jako 0", () => {
    expect(computePoints({kabina: undefined as any, rolka: NaN, dziubek: null as any}, VARS).pointsTotal).toBe(0);
  });

  it("wynik zaokrąglony do 2 miejsc — brak artefaktów float (0.1·3 = 0.3, nie 0.30000000000000004)", () => {
    const v: KmVars = {...VARS, ptsEskimoska: 0.1};
    expect(computePoints({kabina: 0, rolka: 3, dziubek: 0}, v).pointsTotal).toBe(0.3);
    const v2: KmVars = {...VARS, ptsDziubek: 1 / 3};
    expect(computePoints({kabina: 0, rolka: 0, dziubek: 1}, v2).pointsTotal).toBe(0.33);
  });

  it("stawki z arkusza inne niż domyślne są respektowane", () => {
    const v: KmVars = {ptsKabina: 3, ptsEskimoska: 2, ptsDziubek: 1, scoringVersion: "v2"};
    const r = computePoints({kabina: 1, rolka: 1, dziubek: 1}, v);
    expect(r.pointsTotal).toBe(6);
    expect(r.scoringVersion).toBe("v2");
  });
});

describe("getYearFromDate / getSeasonKeyFromDate", () => {
  it("rok z daty ISO; sezon = rok (MVP)", () => {
    expect(getYearFromDate("2026-05-01")).toBe(2026);
    expect(getSeasonKeyFromDate("2026-05-01")).toBe("2026");
  });

  it("niepoprawna data → bieżący rok (fallback), sezon = surowy prefiks", () => {
    expect(getYearFromDate("")).toBe(new Date().getFullYear());
    expect(getYearFromDate("abcd-01-01")).toBe(new Date().getFullYear());
    expect(getSeasonKeyFromDate("")).toBe("");
  });
});

describe("getKmVars — setup/vars_kurs", () => {
  it("brak dokumentu → 1 / 0.5 / 0.25 / v1", async () => {
    expect(await getKmVars(new FakeFirestore().asDb())).toEqual({ptsKabina: 1, ptsEskimoska: 0.5, ptsDziubek: 0.25, scoringVersion: "v1"});
  });

  it("wartości z arkusza (także jako stringi); nieparsowalne → fallback", async () => {
    const db = new FakeFirestore({setup: [{_docId: "vars_kurs", vars: {"kabina_punkty": {value: "2"}, "eskimoska_punkty": {value: 1}, "dziubek_punkty": {value: "abc"}}}]}).asDb();
    expect(await getKmVars(db)).toEqual({ptsKabina: 2, ptsEskimoska: 1, ptsDziubek: 0.25, scoringVersion: "v1"});
  });
});

describe("tokenizeName — tokeny wyszukiwania akwenów", () => {
  it("pełna nazwa + słowa + prefiksy słów (min 2 znaki), wszystko lowercase", () => {
    const t = tokenizeName("Rzeka Radunia");
    expect(t[0]).toBe("rzeka radunia");
    for (const expected of ["rzeka", "radunia", "rz", "rze", "rzek", "ra", "rad", "radu", "radun", "raduni"]) {
      expect(t).toContain(expected);
    }
    expect(t.some((x) => x.length < 2)).toBe(false);
    expect(new Set(t).size).toBe(t.length);
  });

  it("pojedyncze słowo: brak duplikatu pełnej nazwy i słowa", () => {
    expect(tokenizeName("BRDA")).toEqual(["brda", "br", "brd"]);
  });

  it("puste / białe znaki → []", () => {
    expect(tokenizeName("")).toEqual([]);
    expect(tokenizeName("   ")).toEqual([]);
  });

  it("wielokrotne spacje/tabulatory wewnątrz nazwy zwijane do pojedynczej spacji w tokenie pełnej nazwy", () => {
    const t = tokenizeName("  Jezioro   Wdzydze ");
    expect(t[0]).toBe("jezioro wdzydze");
    expect(t).not.toContain("jezioro   wdzydze");
    expect(t).toContain("jezioro");
    expect(t).toContain("wdzydze");
    expect(tokenizeName("Rzeka\tRadunia")[0]).toBe("rzeka radunia");
  });

  it("limit 50 tokenów dla bardzo długich nazw", () => {
    const long = Array.from({length: 12}, (_, i) => `slowo${i}dlugie`).join(" ");
    expect(tokenizeName(long)).toHaveLength(50);
  });
});
