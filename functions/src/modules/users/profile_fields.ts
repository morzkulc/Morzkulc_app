/** Wspólna normalizacja/walidacja pól profilu (rejestracja + edycja własnych danych). */

export function normalizePhone(v: any): string {
  return String(v || "").trim().replace(/\s+/g, " ");
}

/** Cyfry numeru bez spacji/myślników; zachowuje wiodący „+”. */
function normalizePhoneDigits(v: string): string {
  const s = String(v || "").trim();
  if (!s) return "";
  const digits = s.replace(/[^\d]/g, "");
  return s.startsWith("+") ? "+" + digits : digits;
}

/** Liberalnie, ale sensownie: 8–15 cyfr. */
export function isPhoneValid(v: string): boolean {
  const digitsCount = normalizePhoneDigits(v).replace(/[^\d]/g, "").length;
  return digitsCount >= 8 && digitsCount <= 15;
}

/** Imię / nazwisko: przycięte, pojedyncze spacje, maks. 60 znaków. */
export function normalizePersonName(v: any): string {
  return String(v || "").trim().replace(/\s+/g, " ").slice(0, 60);
}
