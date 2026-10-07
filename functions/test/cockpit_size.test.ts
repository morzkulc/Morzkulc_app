/**
 * Rozmiar kokpitu kajaka (R2–R5) — czysta funkcja frontendu
 * public/core/cockpit_size.js, pokazywana w szczegółach kajaka.
 */
import {describe, it, expect} from "vitest";
// @ts-expect-error — moduł JS frontendu bez deklaracji typów
import {formatCockpitSize} from "../../public/core/cockpit_size.js";

describe("formatCockpitSize", () => {
  it("długość i szerokość zgodne → jeden rozmiar", () => {
    expect(formatCockpitSize("86x48")).toBe("R4 (86x48)");
    expect(formatCockpitSize("71x42")).toBe("R2 (71x42)");
    expect(formatCockpitSize("81x45")).toBe("R3 (81x45)");
  });

  it("szerokość na granicy dwóch rozmiarów → wspólny z długością", () => {
    expect(formatCockpitSize("82x44")).toBe("R3 (82x44)");
    expect(formatCockpitSize("93x50")).toBe("R5 (93x50)");
  });

  it("rozbieżne wymiary → zakres", () => {
    expect(formatCockpitSize("88x45")).toBe("R3–R4 (88x45)");
    expect(formatCockpitSize("88x42")).toBe("R2–R4 (88x42)");
    expect(formatCockpitSize("87x51")).toBe("R4–R5 (87x51)");
  });

  it("spacje i ×/X w zapisie są tolerowane", () => {
    expect(formatCockpitSize("92 x 50")).toBe("R5 (92x50)");
    expect(formatCockpitSize("86X48")).toBe("R4 (86x48)");
    expect(formatCockpitSize("86×48")).toBe("R4 (86x48)");
  });

  it("puste → brak danych; nieczytelne → surowy tekst; poza tabelą → komunikat", () => {
    expect(formatCockpitSize("")).toBe("brak danych");
    expect(formatCockpitSize(undefined)).toBe("brak danych");
    expect(formatCockpitSize("duży")).toBe("duży");
    expect(formatCockpitSize("100x48")).toBe("poza rozmiarówką R2–R5 (100x48)");
  });
});
