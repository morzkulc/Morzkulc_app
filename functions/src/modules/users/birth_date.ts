/**
 * Data urodzenia — walidacja wspólna dla rejestracji, edycji „Moje dane” i sprawdzenia przy starcie
 * aplikacji (decyzja 04.11.2026): członkowie co do zasady pełnoletni; od wiek_min_czlonka (16)
 * warunkowo (zgoda Zarządu + przedstawiciela ustawowego, mail do Zarządu); powyżej wiek_max (100)
 * albo poniżej minimum — data niepoprawna, osoba ma ją poprawić.
 */

export type AgeLimits = {min: number; adult: number; max: number};

export type BirthDateCode = "invalid_format" | "cannot_be_future" | "too_young" | "too_old" | "minor" | "adult";

export type BirthDateCheck = {
  /** Data do przyjęcia (adult albo minor). */
  ok: boolean;
  code: BirthDateCode;
  age: number | null;
};

/** Ścisłe YYYY-MM-DD i istniejąca data (bez przesuwania 31.02 → 03.03). */
export function isIsoDateYYYYMMDD(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Ukończone lata w dniu todayIso (urodziny tego dnia = ukończone). */
export function ageOn(dobIso: string, todayIso: string): number {
  const [y, m, d] = dobIso.split("-").map(Number);
  const [ty, tm, td] = todayIso.split("-").map(Number);
  let age = ty - y;
  if (tm < m || (tm === m && td < d)) age--;
  return age;
}

export function checkBirthDate(dobRaw: any, todayIso: string, limits: AgeLimits): BirthDateCheck {
  const dob = String(dobRaw || "").trim();
  if (!isIsoDateYYYYMMDD(dob)) return {ok: false, code: "invalid_format", age: null};
  if (dob > todayIso) return {ok: false, code: "cannot_be_future", age: null};
  const age = ageOn(dob, todayIso);
  if (age < limits.min) return {ok: false, code: "too_young", age};
  if (age > limits.max) return {ok: false, code: "too_old", age};
  return {ok: true, code: age < limits.adult ? "minor" : "adult", age};
}

/** Komunikat dla użytkownika (ten sam tekst w rejestracji, „Moich danych” i pop-upie startowym). */
export function birthDateMessage(code: BirthDateCode, limits: AgeLimits): string {
  if (code === "invalid_format") return "Data urodzenia ma nieprawidłowy format.";
  if (code === "cannot_be_future") return "Data urodzenia nie może być w przyszłości.";
  if (code === "too_young") return `Członkiem klubu może zostać osoba, która ukończyła ${limits.min} lat — sprawdź datę urodzenia.`;
  if (code === "too_old") return `Data urodzenia wskazuje wiek powyżej ${limits.max} lat — sprawdź rok urodzenia.`;
  if (code === "minor") {
    return `Członkostwo osoby, która nie ukończyła ${limits.adult} lat, wymaga zgody Zarządu Klubu oraz pisemnej zgody ` +
      "przedstawiciela ustawowego. Zarząd skontaktuje się z Tobą.";
  }
  return "";
}
