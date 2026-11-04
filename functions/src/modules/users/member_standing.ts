import {normNullish} from "../shared/text_utils";
import {todayWarsawIso} from "../shared/date_range_utils";

/** Pełni członkowie klubu (głosujący). Kandydaci, sympatycy i kursanci poza. */
export const FULL_MEMBER_ROLE_KEYS = ["rola_czlonek", "rola_zarzad", "rola_kr"];

/** Członkowie klubu łącznie z kandydatami (kandydat to też forma członkostwa) — np. prawo do karnetu basenowego. */
export const MEMBER_ROLE_KEYS = [...FULL_MEMBER_ROLE_KEYS, "rola_kandydat"];

/**
 * Role, które widzą dane kontaktowe innych osób (e-mail z listy kluczy, właściciela kajaka).
 * Sympatyk (każde konto Google po zalogowaniu) i kursant — nie (RODO: minimalizacja, 30.10.2026).
 */
export const CONTACT_VISIBLE_ROLE_KEYS = ["rola_czlonek", "rola_kandydat", "rola_kr", "rola_zarzad"];

export const SUSPENDED_STATUS_KEY = "status_zawieszony";

export function isSuspended(userData: any): boolean {
  return String(userData?.status_key || "").trim() === SUSPENDED_STATUS_KEY;
}

/**
 * Rola do UPRAWNIEŃ: członek z „Zawieszony” ma dostęp jak sympatyk (decyzja 03.11.2026).
 * W bazie i arkuszu role_key zostaje prawdziwa (po odwieszeniu wraca bez zmian) — dlatego
 * każdy odczyt roli do sprawdzenia uprawnień idzie przez tę funkcję, a raporty/arkusz czytają role_key.
 */
export function effectiveRoleKey(userData: any): string {
  const role = String(userData?.role_key || "").trim();
  if (!role) return "";
  return isSuspended(userData) ? "rola_sympatyk" : role;
}

export function canSeeMemberContacts(roleKey: string): boolean {
  return CONTACT_VISIBLE_ROLE_KEYS.includes(String(roleKey || ""));
}

/**
 * „Składki opłacone do" (YYYY-MM-DD | DD-MM-YYYY | DD.MM.YYYY) → "YYYY-MM-DD" lub "".
 * Nieistniejąca data (np. 2027-02-29) → "" — Date.UTC po cichu przesunęłaby ją na 01.03.
 */
export function contributionsIso(raw: any): string {
  const s = normNullish(raw);
  if (!s) return "";
  let y: number; let mo: number; let d: number;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    [y, mo, d] = [+m[1], +m[2], +m[3]];
  } else {
    m = s.match(/^(\d{2})[-.](\d{2})[-.](\d{4})$/);
    if (!m) return "";
    [y, mo, d] = [+m[3], +m[2], +m[1]];
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return "";
  return dt.toISOString().slice(0, 10);
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * „Opłacone do" w praktyce: jak contributionsIso, ale 28.02 w roku przestępnym = 29.02
 * (koniec semestru to ostatni dzień lutego; w arkuszu wpisuje się 28 — decyzja 02.11.2026).
 */
export function effectivePaidUntilIso(raw: any): string {
  const iso = contributionsIso(raw);
  if (iso.slice(5) === "02-28" && isLeapYear(Number(iso.slice(0, 4)))) return `${iso.slice(0, 4)}-02-29`;
  return iso;
}

/** Parsuje „składki opłacone do" → Date (UTC) lub null (także dla nieistniejącej daty). */
export function parseContributionsPaidUntil(raw: any): Date | null {
  const iso = effectivePaidUntilIso(raw);
  return iso ? new Date(iso + "T00:00:00.000Z") : null;
}

/**
 * Data „opłacone do" musi być końcem semestru z SETUP (semestr_1_stop / semestr_2_stop, „mm-dd”).
 * „02-28” w SETUP dopuszcza też 29.02 w roku przestępnym. False dla daty nieczytelnej/nieistniejącej
 * albo przy braku końców semestrów.
 */
export function isSemesterEndDate(raw: any, semesterEnds: string[]): boolean {
  const iso = contributionsIso(raw);
  if (!iso) return false;
  const mmdd = iso.slice(5);
  return semesterEnds.includes(mmdd) || (mmdd === "02-29" && semesterEnds.includes("02-28"));
}

/** Surowa wartość „składki opłacone do" z dokumentu users_active. */
export function contributionsRaw(userData: any): string {
  return normNullish(userData?.contributionsPaidUntil ?? userData?.admin?.contributions);
}

/** Składki opłacone: data „opłacone do" nie wcześniejsza niż dziś (czas warszawski). */
export function isDuesPaid(userData: any, todayIso: string = todayWarsawIso()): boolean {
  const paidUntil = parseContributionsPaidUntil(contributionsRaw(userData));
  return Boolean(paidUntil && paidUntil.getTime() >= new Date(todayIso + "T00:00:00.000Z").getTime());
}

/**
 * Miesiąc wpłaty wpisowego z kolumny „Wpisowe (mm.yyyy)” → "YYYY-MM" lub "" (decyzja 02.11.2026).
 * Przyjmuje „MM.RRRR” / „M.RRRR” i „RRRR-MM”. Ważność wpisowego nie wynika z tej daty — wpisowe
 * (2 semestry) jest wpisane w kolumnie „Składki”, tak jak składka.
 */
export function parseEntryFeeMonth(raw: any): string {
  const s = normNullish(raw);
  let m = s.match(/^(\d{1,2})\.(\d{4})$/);
  let y = 0;
  let mo = 0;
  if (m) {
    [mo, y] = [Number(m[1]), Number(m[2])];
  } else {
    m = s.match(/^(\d{4})-(\d{2})$/);
    if (!m) return "";
    [y, mo] = [Number(m[1]), Number(m[2])];
  }
  if (mo < 1 || mo > 12 || y < 1975) return "";
  return `${y}-${String(mo).padStart(2, "0")}`;
}

/**
 * Czynny członek: opłacone składki i dodatnie saldo godzinek. Ta sama reguła wyznacza
 * prawo głosu (raport składek) i prawo do karnetu basenowego (dofinansowanie klubu).
 */
export function isInGoodStanding(duesPaid: boolean, godzinkiBalance: number): boolean {
  return duesPaid && godzinkiBalance > 0;
}
