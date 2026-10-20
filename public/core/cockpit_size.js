// Rozmiar kokpitu / fartucha wg rozmiarówki fartuchów Palm (R2–R6).
// Wejście = "dł x szer" w cm (np. "88x45", "92 x 50") — kolumna "Kokpit" kajaków
// albo "Rozmiar" fartuchów. Czysta funkcja — testy: functions/test/cockpit_size.test.ts.

// Rozmiarówka Palm (palm.equipment, karta Roanoke Deck): górne granice długości
// i szerokości (cm) każdego rozmiaru. Przedziały liczymy jako [min, max) — wartość
// na styku dwóch rozmiarów (np. długość 75) idzie do większego, zgodnie z zasadą
// Palma „use the largest dimension”.
const SPRAYSKIRT_SIZES = [
  { code: "R2", lengthMax: 75, widthMax: 44 },
  { code: "R3", lengthMax: 83, widthMax: 47 },
  { code: "R4", lengthMax: 89, widthMax: 50 },
  { code: "R5", lengthMax: 95, widthMax: 53 },
  { code: "R6", lengthMax: 101, widthMax: 56 }
];

// Poniżej R2 → R2, powyżej R6 → R6: każdy wymiar dostaje rozmiar (decyzja
// użytkownika 17.10.2026 — „nie mogą być poza rozmiarem”).
function sizeIndexFor(value, maxKey) {
  const i = SPRAYSKIRT_SIZES.findIndex((s) => value < s[maxKey]);
  return i === -1 ? SPRAYSKIRT_SIZES.length - 1 : i;
}

/**
 * Zwraca etykietę rozmiaru, np. "R4 (88x45)":
 * - pusta wartość → "brak danych",
 * - nieczytelny format (np. "regulowany") → surowy tekst,
 * - rozmiar = większy z rozmiarów wskazanych przez długość i szerokość (reguła Palma).
 */
export function formatCockpitSize(raw) {
  return formatWithShift(raw, 0);
}

/**
 * Fartuch: kolumna "Rozmiar" = wymiary zmierzone NA PŁASKO. Neopren się rozciąga,
 * więc fartuch pasuje na kokpit o jeden rozmiar większy niż wychodzi z tabeli
 * (płaskie R3 → kokpit R4; zasada użytkownika 17.10.2026). R6 zostaje R6.
 */
export function formatSprayskirtSize(raw) {
  return formatWithShift(raw, 1);
}

function formatWithShift(raw, shift) {
  const text = String(raw ?? "").trim();
  if (!text) return "brak danych";

  const m = text.match(/^(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)$/i);
  if (!m) return text;

  const length = Number(m[1].replace(",", "."));
  const width = Number(m[2].replace(",", "."));
  const idx = Math.max(sizeIndexFor(length, "lengthMax"), sizeIndexFor(width, "widthMax"));
  const shifted = Math.min(idx + shift, SPRAYSKIRT_SIZES.length - 1);
  return `${SPRAYSKIRT_SIZES[shifted].code} (${m[1]}x${m[2]})`;
}
