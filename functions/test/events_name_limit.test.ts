/**
 * Limit długości nazwy imprezy (EVENT_NAME_MAX = 60, decyzja 24.11.2026):
 *  - zgłoszenie z aplikacji: createEvent odrzuca za długą nazwę,
 *  - sync z arkusza: za długa nazwa w NOWYM wierszu lub ZMIENIONA wstrzymuje cały sync;
 *    istniejące, niezmienione wpisy nie są sprawdzane.
 */
import {describe, it, expect} from "vitest";
import {createEvent, EVENT_NAME_MAX} from "../src/modules/calendar/events_service";
import {findTooLongEventNames, buildTooLongNamesMessage} from "../src/service/tasks/eventsSyncFromSheet";

const n = (len: number) => "x".repeat(len);
const baseArgs = {
  uid: "u1", email: "a@b.pl", startDate: "2026-12-01", endDate: "2026-12-02",
  location: "Ostrzyce", description: "", contact: "", link: "", mapLink: "",
};

describe("createEvent — limit nazwy", () => {
  it("EVENT_NAME_MAX = 60", () => {
    expect(EVENT_NAME_MAX).toBe(60);
  });

  it("nazwa 61 znaków → validation_failed z komunikatem PL", async () => {
    const out = await createEvent({} as any, {...baseArgs, name: n(61)});
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.code).toBe("validation_failed");
      expect(out.message).toContain("61 znaków");
    }
  });
});

describe("findTooLongEventNames — sync z arkusza", () => {
  const existing = new Map<string, string>([["e1", n(162)], ["e2", "Krótka"]]);

  it("istniejący, niezmieniony długi wpis NIE blokuje", () => {
    expect(findTooLongEventNames([{rowNumber: 2, sheetId: "e1", name: n(162)}], existing)).toEqual([]);
  });

  it("nowy wiersz bez ID z długą nazwą → blokuje", () => {
    const out = findTooLongEventNames([{rowNumber: 5, sheetId: "", name: n(70)}], existing);
    expect(out).toEqual([{rowNumber: 5, sheetId: "", name: n(70), length: 70}]);
  });

  it("ID nieobecne w Firestore (nowy) → blokuje", () => {
    expect(findTooLongEventNames([{rowNumber: 6, sheetId: "zzz", name: n(61)}], existing)).toHaveLength(1);
  });

  it("zmieniona nazwa na za długą → blokuje", () => {
    expect(findTooLongEventNames([{rowNumber: 3, sheetId: "e2", name: n(61)}], existing)).toHaveLength(1);
  });

  it("zmieniony długi wpis na inny długi → blokuje", () => {
    expect(findTooLongEventNames([{rowNumber: 2, sheetId: "e1", name: n(161)}], existing)).toHaveLength(1);
  });

  it("dokładnie 60 znaków → OK", () => {
    expect(findTooLongEventNames([{rowNumber: 4, sheetId: "", name: n(60)}], existing)).toEqual([]);
  });

  it("komunikat zawiera numer wiersza i długość", () => {
    const msg = buildTooLongNamesMessage([{rowNumber: 7, sheetId: "", name: n(70), length: 70}]);
    expect(msg).toContain("wstrzymana");
    expect(msg).toContain("wiersz 7: 70 zn.");
  });
});
