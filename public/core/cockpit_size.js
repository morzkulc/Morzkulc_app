// Rozmiar kokpitu / fartucha wg rozmiarówki fartuchów Palm (R2–R6).
// Wejście = "dł x szer" w cm (np. "88x45", "92 x 50") — kolumna "Kokpit" kajaków
// albo "Rozmiar" fartuchów. Czysta funkcja — testy: functions/test/cockpit_size.test.ts.

// Rozmiarówka Palm (palm.equipment, karta Roanoke Deck): górne granice długości
// i szerokości (cm) każdego rozmiaru. Wartość na styku dwóch rozmiarów (np. długość 89):
// - fartuch → większy rozmiar, przedziały [min, max),
// - kokpit → plakietka MNIEJSZEGO rozmiaru, przedziały (min, max], ale pasują fartuchy
//   obu rozmiarów (cockpitFittingDecks) — przymiarka 28.10.2026: na kokpity 89x45
//   i 86x50 pasują fartuchy R4 i R5.
const SPRAYSKIRT_SIZES = [
  { code: "R2", lengthMax: 75, widthMax: 44 },
  { code: "R3", lengthMax: 83, widthMax: 47 },
  { code: "R4", lengthMax: 89, widthMax: 50 },
  { code: "R5", lengthMax: 95, widthMax: 53 },
  { code: "R6", lengthMax: 101, widthMax: 56 }
];

// Poniżej R2 → R2, powyżej R6 → R6: każdy wymiar dostaje rozmiar (decyzja
// użytkownika 17.10.2026 — „nie mogą być poza rozmiarem”).
function sizeIndexFor(value, maxKey, edgeToSmaller) {
  const i = SPRAYSKIRT_SIZES.findIndex((s) => (edgeToSmaller ? value <= s[maxKey] : value < s[maxKey]));
  return i === -1 ? SPRAYSKIRT_SIZES.length - 1 : i;
}

/**
 * Zwraca etykietę rozmiaru, np. "R4 (88x45)":
 * - pusta wartość → "brak danych",
 * - nieczytelny format (np. "regulowany") → surowy tekst,
 * - rozmiar = większy z rozmiarów wskazanych przez długość i szerokość (reguła Palma).
 */
export function formatCockpitSize(raw) {
  return formatWithShift(raw, 0, true);
}

/**
 * Fartuch: kolumna "Rozmiar" = wymiary zmierzone NA PŁASKO. Neopren się rozciąga,
 * więc fartuch pasuje na kokpit o jeden rozmiar większy niż wychodzi z tabeli
 * (płaskie R3 → kokpit R4; zasada użytkownika 17.10.2026). R6 zostaje R6.
 */
export function formatSprayskirtSize(raw) {
  return formatWithShift(raw, 1, false);
}

// Mniejsze decki, na które fartuch też pasuje (przymiarka 28.10.2026: fartuch R6
// trzyma na kokpicie R5).
const SPRAYSKIRT_ALSO_FITS = { R6: ["R5"] };

export function sprayskirtAlsoFits(deck) {
  return SPRAYSKIRT_ALSO_FITS[deck] || [];
}

/**
 * Decki fartuchów pasujące na kokpit: rozmiar kokpitu, przy wymiarze na styku także
 * większy, plus decki z SPRAYSKIRT_ALSO_FITS (R6 na R5). Np. "86x50" → ["R4", "R5", "R6"].
 * Brak/nieczytelny wymiar → [].
 */
export function cockpitFittingDecks(raw) {
  const dims = parseDims(raw);
  if (!dims) return [];
  const from = sizeIndexOf(dims, true);
  const to = sizeIndexOf(dims, false);
  const decks = SPRAYSKIRT_SIZES.slice(from, to + 1).map((s) => s.code);
  for (const [deck, smaller] of Object.entries(SPRAYSKIRT_ALSO_FITS)) {
    if (!decks.includes(deck) && smaller.some((d) => decks.includes(d))) decks.push(deck);
  }
  return decks;
}

// Dopasowanie po obwodzie elipsy (pomysł do weryfikacji, przymiarka 28.10.2026):
// fartuch (wymiar na płasko) pasuje, gdy jego obwód to 83–100% obwodu kokpitu.
// Próg 0,83 rozdzielił 14 z 15 testów; powyżej 1,00 nie było testów, więc tam
// nie twierdzimy, że pasuje. Stałe zmieniamy po kolejnych przymiarkach.
const FIT_PERIMETER_MIN = 0.83;
const FIT_PERIMETER_MAX = 1.0;

// Obwód elipsy o osiach dł x szer (przybliżenie Ramanujana).
function ellipsePerimeter(dims) {
  const a = dims.length / 2;
  const b = dims.width / 2;
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
}

/** Czy fartuch (wymiar na płasko, np. "76X46") pasuje na kokpit (np. "86x50"). */
export function sprayskirtFitsCockpit(skirtRaw, cockpitRaw) {
  const skirt = parseDims(skirtRaw);
  const cockpit = parseDims(cockpitRaw);
  if (!skirt || !cockpit) return false;
  const ratio = ellipsePerimeter(skirt) / ellipsePerimeter(cockpit);
  return ratio >= FIT_PERIMETER_MIN && ratio <= FIT_PERIMETER_MAX;
}

function parseDims(raw) {
  const m = String(raw ?? "").trim().match(/^(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)$/i);
  if (!m) return null;
  return { lengthText: m[1], widthText: m[2], length: Number(m[1].replace(",", ".")), width: Number(m[2].replace(",", ".")) };
}

function sizeIndexOf(dims, edgeToSmaller) {
  return Math.max(
    sizeIndexFor(dims.length, "lengthMax", edgeToSmaller),
    sizeIndexFor(dims.width, "widthMax", edgeToSmaller)
  );
}

function formatWithShift(raw, shift, edgeToSmaller) {
  const text = String(raw ?? "").trim();
  if (!text) return "brak danych";

  const dims = parseDims(text);
  if (!dims) return text;

  const idx = sizeIndexOf(dims, edgeToSmaller);
  const shifted = Math.min(idx + shift, SPRAYSKIRT_SIZES.length - 1);
  return `${SPRAYSKIRT_SIZES[shifted].code} (${dims.lengthText}x${dims.widthText})`;
}
