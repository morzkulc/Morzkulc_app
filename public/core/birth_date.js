// public/core/birth_date.js
// Sprawdzenie daty urodzenia w przeglądarce — od razu po wpisaniu (serwer sprawdza to samo przy zapisie:
// functions/src/modules/users/birth_date.ts; teksty komunikatów muszą być takie same).
// Progi z /api/setup (ctx.ageLimits ← SETUP wiek_min_czlonka / wiek_pelnoletnosci / wiek_max).

export const DEFAULT_AGE_LIMITS = { min: 16, adult: 18, max: 100 };

function localTodayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function isIsoDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function ageOn(dob, today) {
  const [y, m, d] = dob.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  let a = ty - y;
  if (tm < m || (tm === m && td < d)) a--;
  return a;
}

/** {ok, code, message}: ok=false → zapis zablokowany; code "minor" → ok, ale z informacją. */
export function checkBirthDateClient(dobRaw, limitsIn) {
  const L = { ...DEFAULT_AGE_LIMITS, ...(limitsIn || {}) };
  const dob = String(dobRaw || "").trim();
  const today = localTodayIso();
  if (!isIsoDate(dob)) return { ok: false, code: "invalid_format", message: "Data urodzenia ma nieprawidłowy format." };
  if (dob > today) return { ok: false, code: "cannot_be_future", message: "Data urodzenia nie może być w przyszłości." };
  const age = ageOn(dob, today);
  if (age < L.min) return { ok: false, code: "too_young", message: `Członkiem klubu może zostać osoba, która ukończyła ${L.min} lat — sprawdź datę urodzenia.` };
  if (age > L.max) return { ok: false, code: "too_old", message: `Data urodzenia wskazuje wiek powyżej ${L.max} lat — sprawdź rok urodzenia.` };
  if (age < L.adult) {
    return { ok: true, code: "minor", message: `Członkostwo osoby, która nie ukończyła ${L.adult} lat, wymaga zgody Zarządu Klubu oraz pisemnej zgody przedstawiciela ustawowego. Zarząd skontaktuje się z Tobą.` };
  }
  return { ok: true, code: "adult", message: "" };
}
