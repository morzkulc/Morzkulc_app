/**
 * Wspólne pomocniki tekstowe (D4: norm() było kopiowane per plik).
 */

/** Bezpieczna normalizacja do przyciętego stringa ("" dla null/undefined). */
export function norm(v: any): string {
  return String(v || "").trim();
}

/**
 * Jak norm(), ale zachowuje falsy-a-zdefiniowane wartości (0, false) zamiast
 * zamieniać je na "" — tylko null/undefined stają się "". Używane tam, gdzie pole
 * może realnie być liczbą 0 (np. km, godziny), którą norm() by wyzerował do "".
 */
export function normNullish(v: any): string {
  return String(v == null ? "" : v).trim();
}
