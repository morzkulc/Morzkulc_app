/**
 * Rozmiar kokpitu / fartucha (Palm R2–R6) — czysta funkcja frontendu
 * public/core/cockpit_size.js, pokazywana w szczegółach kajaka i na karcie fartucha.
 */
import {describe, it, expect} from "vitest";
// @ts-expect-error — moduł JS frontendu bez deklaracji typów
import {cockpitFittingDecks, formatCockpitSize, formatSprayskirtSize, sprayskirtAlsoFits, sprayskirtFitsCockpit} from "../../public/core/cockpit_size.js";

describe("formatSprayskirtSize (fartuch mierzony na płasko → +1 rozmiar)", () => {
  it("płaskie R3 → R4, R2 → R3, R6 zostaje R6", () => {
    expect(formatSprayskirtSize("76x46")).toBe("R4 (76x46)");
    expect(formatSprayskirtSize("70x43")).toBe("R3 (70x43)");
    expect(formatSprayskirtSize("82x55")).toBe("R6 (82x55)");
  });

  it("wymiar na styku → większy rozmiar (inaczej niż kokpit)", () => {
    expect(formatSprayskirtSize("70x44")).toBe("R4 (70x44)");
  });

  it("R6 pasuje też na R5, pozostałe tylko na swój deck", () => {
    expect(sprayskirtAlsoFits("R6")).toEqual(["R5"]);
    expect(sprayskirtAlsoFits("R4")).toEqual([]);
    expect(sprayskirtAlsoFits("_none")).toEqual([]);
  });

  it("tekst bez wymiarów bez zmian", () => {
    expect(formatSprayskirtSize("regulowany")).toBe("regulowany");
    expect(formatSprayskirtSize("")).toBe("brak danych");
  });
});

describe("sprayskirtFitsCockpit (obwód elipsy 83–100%, przymiarka 28.10.2026)", () => {
  it("wyniki przymiarki: pasuje", () => {
    expect(sprayskirtFitsCockpit("70X40", "81x46")).toBe(true); // T3
    expect(sprayskirtFitsCockpit("65X49", "89x45")).toBe(true); // T13
    expect(sprayskirtFitsCockpit("76X46", "86x50")).toBe(true); // T14
    expect(sprayskirtFitsCockpit("82X55", "86x50")).toBe(true); // T15
  });

  it("wyniki przymiarki: nie pasuje", () => {
    expect(sprayskirtFitsCockpit("65X49", "92x52")).toBe(false); // T6
    expect(sprayskirtFitsCockpit("70X40", "88x48")).toBe(false); // T1
  });

  it("fartuch większy od kokpitu (niesprawdzone) i brak wymiarów → false", () => {
    expect(sprayskirtFitsCockpit("82X55", "76x44")).toBe(false);
    expect(sprayskirtFitsCockpit("regulowany", "86x50")).toBe(false);
    expect(sprayskirtFitsCockpit("76X46", "")).toBe(false);
  });
});

describe("formatCockpitSize", () => {
  it("długość i szerokość zgodne → jeden rozmiar", () => {
    expect(formatCockpitSize("86x48")).toBe("R4 (86x48)");
    expect(formatCockpitSize("71x42")).toBe("R2 (71x42)");
    expect(formatCockpitSize("81x45")).toBe("R3 (81x45)");
    expect(formatCockpitSize("98x54")).toBe("R6 (98x54)");
  });

  it("rozbieżne wymiary → większy rozmiar (reguła Palma)", () => {
    expect(formatCockpitSize("88x45")).toBe("R4 (88x45)");
    expect(formatCockpitSize("87x51")).toBe("R5 (87x51)");
    expect(formatCockpitSize("70x48")).toBe("R4 (70x48)");
  });

  it("wartość na styku dwóch rozmiarów → mniejszy (przymiarka 28.10.2026)", () => {
    expect(formatCockpitSize("75x40")).toBe("R2 (75x40)");
    expect(formatCockpitSize("89x45")).toBe("R4 (89x45)");
    expect(formatCockpitSize("86x50")).toBe("R4 (86x50)");
    expect(formatCockpitSize("89x48")).toBe("R4 (89x48)");
    expect(formatCockpitSize("93x50")).toBe("R5 (93x50)");
  });

  it("poza tabelą → skrajny rozmiar, nigdy „poza rozmiarówką”", () => {
    expect(formatCockpitSize("48x38")).toBe("R2 (48x38)");
    expect(formatCockpitSize("110x60")).toBe("R6 (110x60)");
    expect(formatCockpitSize("82x55")).toBe("R6 (82x55)");
  });

  it("pasujące fartuchy: wymiar na styku → oba rozmiary, R5 → też R6 (przymiarka 28.10.2026)", () => {
    expect(cockpitFittingDecks("89x45")).toEqual(["R4", "R5", "R6"]);
    expect(cockpitFittingDecks("86x50")).toEqual(["R4", "R5", "R6"]);
    expect(cockpitFittingDecks("86x48")).toEqual(["R4"]);
    expect(cockpitFittingDecks("92x52")).toEqual(["R5", "R6"]);
    expect(cockpitFittingDecks("76x44")).toEqual(["R3"]);
    expect(cockpitFittingDecks("")).toEqual([]);
    expect(cockpitFittingDecks("regulowany")).toEqual([]);
  });

  it("spacje i ×/X w zapisie są tolerowane", () => {
    expect(formatCockpitSize("92 x 50")).toBe("R5 (92x50)");
    expect(formatCockpitSize("86X48")).toBe("R4 (86x48)");
    expect(formatCockpitSize("86×48")).toBe("R4 (86x48)");
  });

  it("puste → brak danych; nieczytelne → surowy tekst", () => {
    expect(formatCockpitSize("")).toBe("brak danych");
    expect(formatCockpitSize(undefined)).toBe("brak danych");
    expect(formatCockpitSize("regulowany")).toBe("regulowany");
  });
});
