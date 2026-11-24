import {normNullish} from "./text_utils";

/** Imię i nazwisko (fallback: nick). Puste "" gdy brak obu. */
export function fullName(u: any): string {
  const p = u?.profile || {};
  const full = [p.firstName, p.lastName].map((s: any) => normNullish(s)).filter(Boolean).join(" ").trim();
  return full || normNullish(p.nickname) || "";
}

export function nickname(u: any): string {
  return normNullish(u?.profile?.nickname);
}

/** Zarejestrowany = ukończona rejestracja (profil z imieniem i nazwiskiem). */
export function isRegistered(u: any): boolean {
  const p = u?.profile || {};
  return Boolean(normNullish(p.firstName) && normNullish(p.lastName));
}

/**
 * Nazwa do list widocznych dla członków (historia/ranking sprzętu, decyzja 24.11.2026):
 * ksywa, a bez ksywy imię + inicjał nazwiska („Jan K.”). Nigdy pełne nazwisko ani e-mail.
 */
export function publicMemberName(u: any): string {
  const nick = nickname(u);
  if (nick) return nick;
  const p = u?.profile || {};
  const first = normNullish(p.firstName);
  const last = normNullish(p.lastName);
  if (first && last) return `${first} ${Array.from(last)[0].toUpperCase()}.`;
  return first || "";
}
