/**
 * E5 (24.11.2026): link do imprezy w aplikacji w opisie wydarzenia kalendarza
 * + linki subskrypcji publicznego kalendarza.
 */
import {describe, it, expect} from "vitest";
import {resolveEventsModuleId, eventAppLink, buildCalendarEventData, calendarAddUrl} from "../src/modules/calendar/calendar_event_data";

describe("resolveEventsModuleId", () => {
  it("po etykiecie Imprezy (prod: modul_4)", () => {
    expect(resolveEventsModuleId({modules: {modul_2: {label: "Sprzęt", enabled: true}, modul_4: {label: "Imprezy", enabled: true}}})).toBe("modul_4");
  });
  it("jawny type ma pierwszeństwo, wyłączony moduł pomijany", () => {
    expect(resolveEventsModuleId({modules: {a: {label: "Imprezy", enabled: false}, b: {type: "imprezy", label: "Wydarzenia"}}})).toBe("b");
  });
  it("brak modułu → pusty", () => {
    expect(resolveEventsModuleId({modules: {}})).toBe("");
    expect(resolveEventsModuleId(null)).toBe("");
  });
});

describe("eventAppLink", () => {
  it("format #/<moduł>/ev-<id>, bez podwójnego ukośnika", () => {
    expect(eventAppLink("https://app.morzkulc.pl/", "modul_4", "abc-123")).toBe("https://app.morzkulc.pl/#/modul_4/ev-abc-123");
  });
  it("brak modułu → brak linku", () => {
    expect(eventAppLink("https://app.morzkulc.pl/", "", "abc")).toBe("");
  });
});

describe("buildCalendarEventData", () => {
  const base = {appUrl: "https://app.morzkulc.pl/", moduleId: "modul_4"};
  it("opis + kontakt + link + link do aplikacji na końcu", () => {
    const d = buildCalendarEventData("e1", {name: " Spływ ", startDate: "2026-12-01", endDate: "2026-12-02", description: "Opis", contact: "Jan", link: "https://x.pl", location: "Rzeka"}, base);
    expect(d).toEqual({
      summary: "Spływ",
      description: "Opis\nKontakt: Jan\nLink: https://x.pl\nImpreza w aplikacji: https://app.morzkulc.pl/#/modul_4/ev-e1",
      location: "Rzeka",
      startDate: "2026-12-01",
      endDate: "2026-12-02",
    });
  });
  it("puste pola pomijane; bez bazy linku opis jak dawniej", () => {
    const d = buildCalendarEventData("e1", {name: "A", startDate: "2026-12-01", endDate: "2026-12-01", description: "Opis"}, {appUrl: "", moduleId: ""});
    expect(d.description).toBe("Opis");
  });
});

describe("calendarAddUrl", () => {
  it("link Google cid (id zakodowane)", () => {
    expect(calendarAddUrl("c_x@group.calendar.google.com")).toBe("https://calendar.google.com/calendar/r?cid=c_x%40group.calendar.google.com");
  });
  it("brak id → pusty", () => {
    expect(calendarAddUrl("")).toBe("");
  });
});
