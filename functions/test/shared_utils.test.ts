/**
 * Testy jednostkowe TS współdzielonych helperów wprowadzonych/skonsolidowanych w Fazie 2
 * audytu 09.09 (D2/D4/D5) — kod, który wcześniej istniał w kilku rozjechanych kopiach:
 *  - norm vs normNullish (0/false zachowane tylko przez normNullish),
 *  - resolveDateRange (4 raporty admina: różne domyślne klucze, "current", dwie definicje miesiąca),
 *  - user_display (fullName / nickname / isRegistered),
 *  - CATEGORY_LABELS / VALID_CATEGORIES vs CATEGORY_COLLECTIONS (spójność dwóch modułów),
 *  - isSupportedDamageCategory (zgłoszenia uszkodzeń),
 *  - calendar_utils (addDaysIso, maxStartIsoByWeeks, isIsoDateYYYYMMDD).
 *
 * Uruchamianie: npm --prefix functions run test
 */
import {describe, it, expect, beforeAll, afterAll, beforeEach, vi} from "vitest";
import {norm, normNullish} from "../src/modules/shared/text_utils";
import {resolveDateRange, todayWarsawIso, minusDays, minusMonths, isIsoDate} from "../src/modules/shared/date_range_utils";
import {fullName, nickname, isRegistered} from "../src/modules/shared/user_display";
import {CATEGORY_LABELS, VALID_CATEGORIES, isSupportedGearCategory} from "../src/modules/equipment/shared/gear_catalog_service";
import {CATEGORY_COLLECTIONS} from "../src/modules/equipment/bundle/gear_bundle_service";
import {isSupportedDamageCategory} from "../src/modules/equipment/damage/gear_damage_service";
import {addDaysIso, parseIsoToUtcDate, isIsoDateYYYYMMDD, maxStartIsoByWeeks, todayIsoUTC} from "../src/modules/calendar/calendar_utils";

describe("norm vs normNullish", () => {
  it("null/undefined → '' w obu; białe znaki przycinane w obu", () => {
    expect(norm(null)).toBe("");
    expect(norm(undefined)).toBe("");
    expect(normNullish(null)).toBe("");
    expect(normNullish(undefined)).toBe("");
    expect(norm("  x ")).toBe("x");
    expect(normNullish("  x ")).toBe("x");
  });

  it("0 i false: norm zeruje do '', normNullish zachowuje — to zamierzona różnica, nie duplikacja", () => {
    expect(norm(0)).toBe("");
    expect(normNullish(0)).toBe("0");
    expect(norm(false)).toBe("");
    expect(normNullish(false)).toBe("false");
    expect(norm(12)).toBe("12");
    expect(normNullish(12)).toBe("12");
  });
});

describe("resolveDateRange — zakresy raportów admina (czas zamrożony: 2026-09-09 w Warszawie)", () => {
  beforeAll(() => {
    vi.useFakeTimers({toFake: ["Date"]});
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-09-09T10:00:00Z"));
  });

  const CUR = {defaultKey: "current" as const, supportsCurrent: true};
  const SEM = {defaultKey: "semester" as const};

  it("todayWarsawIso: data według strefy Europe/Warsaw, nie UTC (22:30Z = już następny dzień)", () => {
    expect(todayWarsawIso()).toBe("2026-09-09");
    vi.setSystemTime(new Date("2026-09-09T22:30:00Z"));
    expect(todayWarsawIso()).toBe("2026-09-10");
  });

  it("raport z 'current': puste/nieznane i 'current' → dziś–dziś", () => {
    expect(resolveDateRange("", "", "", CUR)).toEqual({ok: true, key: "current", from: "2026-09-09", to: "2026-09-09"});
    expect(resolveDateRange("current", "", "", CUR)).toEqual({ok: true, key: "current", from: "2026-09-09", to: "2026-09-09"});
    expect(resolveDateRange("cokolwiek", "", "", CUR)).toMatchObject({key: "current"});
  });

  it("raport bez 'current': 'current' i puste → semestr (dziś − 6 mies.)", () => {
    expect(resolveDateRange("current", "", "", SEM)).toEqual({ok: true, key: "semester", from: "2026-03-09", to: "2026-09-09"});
    expect(resolveDateRange("", "", "", SEM)).toMatchObject({key: "semester", from: "2026-03-09"});
  });

  it("'month': domyślnie 30 dni wstecz, w trybie calendarMonth — miesiąc kalendarzowy", () => {
    expect(resolveDateRange("month", "", "", CUR)).toEqual({ok: true, key: "month", from: "2026-08-10", to: "2026-09-09"});
    expect(resolveDateRange("month", "", "", {...CUR, monthMode: "calendarMonth"})).toEqual({ok: true, key: "month", from: "2026-08-09", to: "2026-09-09"});
  });

  it("'year' i 'semester' liczone w miesiącach kalendarzowych", () => {
    expect(resolveDateRange("year", "", "", CUR)).toMatchObject({key: "year", from: "2025-09-09", to: "2026-09-09"});
    expect(resolveDateRange("semester", "", "", CUR)).toMatchObject({key: "semester", from: "2026-03-09"});
  });

  it("'custom': wymaga YYYY-MM-DD (po przycięciu), od ≤ do", () => {
    expect(resolveDateRange("custom", " 2026-01-01 ", "2026-02-01", SEM)).toEqual({ok: true, key: "custom", from: "2026-01-01", to: "2026-02-01"});
    expect(resolveDateRange("custom", "2026-01-01", "2026-01-01", SEM)).toMatchObject({ok: true});
    expect(resolveDateRange("custom", "01.01.2026", "2026-02-01", SEM)).toMatchObject({ok: false, message: expect.stringContaining("YYYY-MM-DD")});
    expect(resolveDateRange("custom", "", "", SEM)).toMatchObject({ok: false});
    expect(resolveDateRange("custom", "2026-03-01", "2026-02-01", SEM)).toMatchObject({ok: false, message: expect.stringContaining("późniejsza")});
  });

  it("minusDays przez zmianę czasu (DST 29.03) i minusMonths przez przełom roku", () => {
    expect(minusDays("2026-03-29", 1)).toBe("2026-03-28");
    expect(minusDays("2026-01-01", 1)).toBe("2025-12-31");
    expect(minusMonths("2026-01-15", 1)).toBe("2025-12-15");
    expect(minusMonths("2026-09-09", 12)).toBe("2025-09-09");
  });

  it("minusMonths na 29.–31. dniu: dzień przycinany do długości miesiąca docelowego (regresja: setUTCMonth przepełniał 31.03−1 do 03.03)", () => {
    expect(minusMonths("2026-03-31", 1)).toBe("2026-02-28");
    expect(minusMonths("2028-03-31", 1)).toBe("2028-02-29"); // rok przestępny
    expect(minusMonths("2026-05-31", 1)).toBe("2026-04-30");
    expect(minusMonths("2026-03-30", 1)).toBe("2026-02-28");
    expect(minusMonths("2026-01-31", 2)).toBe("2025-11-30");
    expect(minusMonths("2026-08-31", 6)).toBe("2026-02-28");
    expect(minusMonths("2026-03-28", 1)).toBe("2026-02-28"); // dzień mieszczący się w miesiącu — bez zmian
  });

  it("resolveDateRange 'month' w trybie calendarMonth 31.03 → od 28.02 (pełny zakres, bez utraty dni)", () => {
    vi.setSystemTime(new Date("2026-03-31T10:00:00Z"));
    expect(resolveDateRange("month", "", "", {...CUR, monthMode: "calendarMonth"})).toEqual({ok: true, key: "month", from: "2026-02-28", to: "2026-03-31"});
    expect(resolveDateRange("semester", "", "", CUR)).toMatchObject({from: "2025-09-30"});
  });

  it("isIsoDate: tylko dokładnie YYYY-MM-DD", () => {
    expect(isIsoDate("2026-09-09")).toBe(true);
    expect(isIsoDate("2026-9-9")).toBe(false);
    expect(isIsoDate(" 2026-09-09")).toBe(false);
  });
});

describe("user_display", () => {
  it("fullName: imię + nazwisko, pojedyncze z nich, fallback do ksywy, '' gdy brak", () => {
    expect(fullName({profile: {firstName: " Jan ", lastName: "Kowalski"}})).toBe("Jan Kowalski");
    expect(fullName({profile: {firstName: "Jan"}})).toBe("Jan");
    expect(fullName({profile: {lastName: "Kowalski", nickname: "Kowal"}})).toBe("Kowalski");
    expect(fullName({profile: {nickname: "Kowal"}})).toBe("Kowal");
    expect(fullName({profile: {}})).toBe("");
    expect(fullName(null)).toBe("");
    expect(fullName({})).toBe("");
  });

  it("nickname: przycięta ksywa lub ''", () => {
    expect(nickname({profile: {nickname: " Kowal "}})).toBe("Kowal");
    expect(nickname({})).toBe("");
    expect(nickname(undefined)).toBe("");
  });

  it("isRegistered: wymaga OBU pól imię i nazwisko (ksywa nie wystarcza, same spacje nie liczą się)", () => {
    expect(isRegistered({profile: {firstName: "Jan", lastName: "Kowalski"}})).toBe(true);
    expect(isRegistered({profile: {firstName: "Jan"}})).toBe(false);
    expect(isRegistered({profile: {firstName: "Jan", lastName: "  "}})).toBe(false);
    expect(isRegistered({profile: {nickname: "Kowal"}})).toBe(false);
    expect(isRegistered(null)).toBe(false);
  });
});

describe("kategorie sprzętu — spójność między modułami", () => {
  it("CATEGORY_LABELS ma 6 kategorii z etykietami PL; VALID_CATEGORIES = jego klucze", () => {
    expect(CATEGORY_LABELS).toEqual({kayaks: "Kajaki", paddles: "Wiosła", lifejackets: "Kamizelki", helmets: "Kaski", throwbags: "Rzutki", sprayskirts: "Fartuchy"});
    expect(Array.from(VALID_CATEGORIES).sort()).toEqual(Object.keys(CATEGORY_LABELS).sort());
  });

  it("VALID_CATEGORIES (raporty) == klucze CATEGORY_COLLECTIONS (rezerwacje) — jedno źródło prawdy", () => {
    expect(Array.from(VALID_CATEGORIES).sort()).toEqual(Object.keys(CATEGORY_COLLECTIONS).sort());
  });

  it("isSupportedGearCategory (katalog drobnego sprzętu) NIE obejmuje kajaków — mają osobny serwis", () => {
    expect(isSupportedGearCategory("paddles")).toBe(true);
    expect(isSupportedGearCategory(" Helmets ")).toBe(true);
    expect(isSupportedGearCategory("kayaks")).toBe(false);
    expect(isSupportedGearCategory("")).toBe(false);
  });

  it("isSupportedDamageCategory: wszystkie kategorie rezerwacji (z kajakami), odporne na null", () => {
    for (const cat of Object.keys(CATEGORY_COLLECTIONS)) expect(isSupportedDamageCategory(cat)).toBe(true);
    expect(isSupportedDamageCategory(" Paddles ")).toBe(true);
    expect(isSupportedDamageCategory("boats")).toBe(false);
    expect(isSupportedDamageCategory(null as any)).toBe(false);
    expect(isSupportedDamageCategory(undefined as any)).toBe(false);
  });
});

describe("calendar_utils", () => {
  it("addDaysIso: przez miesiąc, rok i luty przestępny (2028)", () => {
    expect(addDaysIso("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysIso("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysIso("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysIso("2026-06-10", 0)).toBe("2026-06-10");
  });

  it("parseIsoToUtcDate: północ UTC, niezależna od strefy maszyny", () => {
    expect(parseIsoToUtcDate("2026-06-10").toISOString()).toBe("2026-06-10T00:00:00.000Z");
  });

  it("isIsoDateYYYYMMDD: przycina białe znaki, odrzuca inne formaty", () => {
    expect(isIsoDateYYYYMMDD(" 2026-06-10 ")).toBe(true);
    expect(isIsoDateYYYYMMDD("10.06.2026")).toBe(false);
    expect(isIsoDateYYYYMMDD("")).toBe(false);
  });

  it("maxStartIsoByWeeks: dziś + tygodnie·7 (UTC); 0/undefined tygodni = dziś", () => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(new Date("2026-07-01T10:00:00Z"));
    try {
      expect(todayIsoUTC()).toBe("2026-07-01");
      expect(maxStartIsoByWeeks(2)).toBe("2026-07-15");
      expect(maxStartIsoByWeeks(0)).toBe("2026-07-01");
      expect(maxStartIsoByWeeks(undefined as any)).toBe("2026-07-01");
    } finally {
      vi.useRealTimers();
    }
  });
});
