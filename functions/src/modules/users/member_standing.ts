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

export function canSeeMemberContacts(roleKey: string): boolean {
  return CONTACT_VISIBLE_ROLE_KEYS.includes(String(roleKey || ""));
}

/** Parsuje „składki opłacone do" (YYYY-MM-DD | DD-MM-YYYY | DD.MM.YYYY) → Date (UTC) lub null. */
export function parseContributionsPaidUntil(raw: any): Date | null {
  const s = normNullish(raw);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{2})[-.](\d{2})[-.](\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return null;
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
 * Wpisowe ważne: 12 miesięcy od wpłaty, do końca tego samego miesiąca rok później
 * (admin.entryFeePaidAt „YYYY-MM”; „2026-06” → ważne do czerwca 2027 — jak „Wpisowe ważne do” w profilu).
 */
export function isEntryFeeValid(userData: any, todayIso: string = todayWarsawIso()): boolean {
  const m = /^(\d{4})-(\d{2})$/.exec(normNullish(userData?.admin?.entryFeePaidAt));
  if (!m) return false;
  const validUntil = `${Number(m[1]) + 1}-${m[2]}`;
  return todayIso.slice(0, 7) <= validUntil;
}

/**
 * Składka „opłacona” dla uprawnień członkowskich (karnet basenowy): opłacone składki
 * ALBO ważne wpisowe — wpisowe kandydata traktujemy jak składkę (decyzja 01.11.2026).
 * Raport składek / prawo głosu nadal liczy wyłącznie składki (isDuesPaid).
 */
export function isDuesOrEntryFeePaid(userData: any, todayIso: string = todayWarsawIso()): boolean {
  return isDuesPaid(userData, todayIso) || isEntryFeeValid(userData, todayIso);
}

/**
 * Czynny członek: opłacone składki i dodatnie saldo godzinek. Ta sama reguła wyznacza
 * prawo głosu (raport składek) i prawo do karnetu basenowego (dofinansowanie klubu).
 */
export function isInGoodStanding(duesPaid: boolean, godzinkiBalance: number): boolean {
  return duesPaid && godzinkiBalance > 0;
}
