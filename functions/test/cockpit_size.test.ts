/**
 * Rozmiar kokpitu / fartucha (Palm R2–R6) — czysta funkcja frontendu
 * public/core/cockpit_size.js, pokazywana w szczegółach kajaka i na karcie fartucha.
 */
import {describe, it, expect} from "vitest";
// @ts-expect-error — moduł JS frontendu bez deklaracji typów
import {formatCockpitSize, formatSprayskirtSize} from "../../public/core/cockpit_size.js";

describe("formatSprayskirtSize (fartuch mierzony na płasko → +1 rozmiar)", () => {
  it("płaskie R3 → R4, R2 → R3, R6 zostaje R6", () => {
    expect(formatSprayskirtSize("76x46")).toBe("R4 (76x46)");
    expect(formatSprayskirtSize("70x43")).toBe("R3 (70x43)");
    expect(formatSprayskirtSize("82x55")).toBe("R6 (82x55)");
  });

  it("tekst bez wymiarów bez zmian", () => {
    expect(formatSprayskirtSize("regulowany")).toBe("regulowany");
    expect(formatSprayskirtSize("")).toBe("brak danych");
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

  it("wartość na styku dwóch rozmiarów → większy", () => {
    expect(formatCockpitSize("75x40")).toBe("R3 (75x40)");
    expect(formatCockpitSize("82x44")).toBe("R3 (82x44)");
    expect(formatCockpitSize("93x50")).toBe("R5 (93x50)");
  });

  it("poza tabelą → skrajny rozmiar, nigdy „poza rozmiarówką”", () => {
    expect(formatCockpitSize("48x38")).toBe("R2 (48x38)");
    expect(formatCockpitSize("110x60")).toBe("R6 (110x60)");
    expect(formatCockpitSize("82x55")).toBe("R6 (82x55)");
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
