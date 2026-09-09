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
