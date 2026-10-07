// Rozmiar kokpitu kajaka wg rozmiarówki fartuchów neoprenowych (R2–R5).
// Wejście = kolumna "Kokpit" z arkusza kajaków w formacie "dł x szer" w cm
// (np. "88x45", "92 x 50"). Czysta funkcja — testy: functions/test/cockpit_size.test.ts.

// Zakresy wymiarów kokpitu (cm) dla każdego rozmiaru fartucha — standardowa
// rozmiarówka producentów, nie parametr klubowy.
const SPRAYSKIRT_SIZES = [
  { code: "R2", lengthMin: 66, lengthMax: 75, widthMin: 40, widthMax: 44 },
  { code: "R3", lengthMin: 75, lengthMax: 83, widthMin: 44, widthMax: 47 },
  { code: "R4", lengthMin: 83, lengthMax: 89, widthMin: 47, widthMax: 50 },
  { code: "R5", lengthMin: 89, lengthMax: 95, widthMin: 50, widthMax: 53 }
];

function sizeIndexesFor(value, minKey, maxKey) {
  const out = [];
  SPRAYSKIRT_SIZES.forEach((s, i) => {
    if (value >= s[minKey] && value <= s[maxKey]) out.push(i);
  });
  return out;
}

/**
 * Zwraca etykietę kokpitu do szczegółów kajaka:
 * - pusta kolumna → "brak danych",
 * - nieczytelny format → surowy tekst z arkusza,
 * - długość i szerokość wskazują ten sam rozmiar → "R4 (86x48)",
 * - wskazują różne rozmiary → zakres "R3–R4 (88x45)" (decyzja użytkownika 07.10.2026),
 * - wymiary poza rozmiarówką → "poza rozmiarówką R2–R5 (100x60)".
 */
export function formatCockpitSize(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "brak danych";

  const m = text.match(/^(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)$/i);
  if (!m) return text;

  const length = Number(m[1].replace(",", "."));
  const width = Number(m[2].replace(",", "."));
  const dims = `${m[1]}x${m[2]}`;

  const byLength = sizeIndexesFor(length, "lengthMin", "lengthMax");
  const byWidth = sizeIndexesFor(width, "widthMin", "widthMax");
  if (!byLength.length || !byWidth.length) return `poza rozmiarówką R2–R5 (${dims})`;

  // Wspólny rozmiar wygrywa; bez wspólnego — rozpiętość od najmniejszego do
  // największego wskazanego.
  const common = byLength.filter((i) => byWidth.includes(i));
  const picked = common.length ? common : [...byLength, ...byWidth];

  const lo = SPRAYSKIRT_SIZES[Math.min(...picked)].code;
  const hi = SPRAYSKIRT_SIZES[Math.max(...picked)].code;
  return `${lo === hi ? lo : `${lo}–${hi}`} (${dims})`;
}
