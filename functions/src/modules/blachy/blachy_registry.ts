/**
 * Rejestr Blach Klubowych (regulamin § 6 pkt 7–8): kolekcja `blachy`.
 *
 * Blacha jest niezależna od członkostwa, składek i godzinek — wpis w rejestrze
 * jest trwały. Źródła wpisów:
 *  - „bilans_otwarcia" — jednorazowy import blach sprzed aplikacji (task blachy.importOpeningBalance),
 *  - „arkusz_czlonkow" — kolumna „blacha" w arkuszu członków (users.syncFieldsFromSheet DOPISUJE,
 *    nigdy nie usuwa ani nie zmienia istniejącego wpisu),
 *  - „aplikacja" — zarząd/KR w module Klub (dodaj / popraw / usuń błędny wpis).
 */

export const BLACHY_COLLECTION = "blachy";

export type BlachaZrodlo = "bilans_otwarcia" | "arkusz_czlonkow" | "aplikacja";

export type BlachaDoc = {
  imie: string;
  nazwisko: string;
  ksywa: string;
  /** Rok nadania; null = nieznany (regulamin § 6 pkt 8: nie zgadujemy). */
  rok: number | null;
  /** Numer Blachy; null = nienadany / nieznany. */
  nr: number | null;
  uzasadnienie: string;
  /** Klub osoby spoza Morzkulca (jeśli dotyczy). */
  klub: string;
  /** Blacha Założycielska w innym klubie (regulamin § 7) — nazwa klubu, jeśli dotyczy. */
  zalozycielska: string;
  /** „ś.p." */
  sp: boolean;
  /** Tylko do dopasowania przy syncu arkusza — nigdy nie trafia do odpowiedzi API. */
  email: string;
  memberId: number | null;
  zrodlo: BlachaZrodlo;
};

const str = (v: any) => String(v == null ? "" : v).trim();

/** Wartość kolumny „blacha": pusta / FALSE / nie / 0 = brak; rok 4-cyfrowy = rok nadania; inna niepusta = blacha, rok nieznany. */
export function parseBlacha(raw: any): {has: boolean; rok: number | null} {
  const s = str(raw).toLowerCase();
  if (!s || s === "false" || s === "nie" || s === "0") return {has: false, rok: null};
  const m = /^(\d{4})$/.exec(s);
  const rok = m ? Number(m[1]) : null;
  return {has: true, rok: rok && rok >= 1900 && rok <= 2100 ? rok : null};
}

/** „ś.p. Paweł" / „ś.p.Agnieszka" → {imie: "Paweł", sp: true}. */
export function splitSp(imie: string): {imie: string; sp: boolean} {
  const m = /^ś\.?\s*p\.?\s*/i.exec(str(imie));
  return m ? {imie: str(imie).slice(m[0].length).trim(), sp: true} : {imie: str(imie), sp: false};
}

/** Klucz porównania osób: małe litery, bez polskich znaków i nawiasów (np. „Woźniak (Górska)"). */
export function personKey(imie: string, nazwisko: string): string {
  const n = (s: string) => str(s).toLowerCase().replace(/ł/g, "l").normalize("NFD").replace(/[̀-ͯ]/g, "");
  const first = n(splitSp(imie).imie).split(/\s+/)[0] || "";
  const last = n(nazwisko).split(/[\s/()-]+/).filter(Boolean)[0] || "";
  return `${first}|${last}`;
}

/** Czy osoba z arkusza członków ma już wpis w rejestrze (e-mail, ID członka albo imię+nazwisko). */
export function findInRegistry(
  entries: Array<{id: string; d: Partial<BlachaDoc>}>,
  who: {email: string; memberId: number | null; imie: string; nazwisko: string}
): string | null {
  const email = str(who.email).toLowerCase();
  const key = personKey(who.imie, who.nazwisko);
  const hit = entries.find(({d}) =>
    (email && str(d.email).toLowerCase() === email) ||
    (who.memberId != null && d.memberId === who.memberId) ||
    (key !== "|" && personKey(str(d.imie), str(d.nazwisko)) === key));
  return hit ? hit.id : null;
}

export type BlachaPublic = {
  id: string;
  imie: string;
  nazwisko: string;
  ksywa: string;
  rok: number | null;
  nr: number | null;
  uzasadnienie: string;
  klub: string;
  zalozycielska: string;
  sp: boolean;
};

/** Pola widoczne dla zalogowanych (regulamin § 6 pkt 2: lista wyróżnionych + uzasadnienia). Bez e-maila. */
export function toPublic(id: string, d: any): BlachaPublic {
  return {
    id,
    imie: str(d?.imie),
    nazwisko: str(d?.nazwisko),
    ksywa: str(d?.ksywa),
    rok: typeof d?.rok === "number" ? d.rok : null,
    nr: typeof d?.nr === "number" ? d.nr : null,
    uzasadnienie: str(d?.uzasadnienie),
    klub: str(d?.klub),
    zalozycielska: str(d?.zalozycielska),
    sp: d?.sp === true,
  };
}

/** Kolejność rejestru: rok nieznany na początku (najstarsze wpisy), potem rosnąco po roku, numerze i nazwisku. */
export function sortRegistry(list: BlachaPublic[]): BlachaPublic[] {
  const r = (x: BlachaPublic) => (x.rok == null ? -1 : x.rok);
  const nr = (x: BlachaPublic) => (x.nr == null ? Number.MAX_SAFE_INTEGER : x.nr);
  return [...list].sort((a, b) => r(a) - r(b) || nr(a) - nr(b) || a.nazwisko.localeCompare(b.nazwisko, "pl"));
}

export type BlachaInput = Pick<BlachaDoc, "imie" | "nazwisko" | "ksywa" | "rok" | "nr" | "uzasadnienie" | "klub" | "zalozycielska" | "sp">;

/** Walidacja formularza zarządu (dodanie / poprawka wpisu). */
export function validateBlachaInput(body: any, thisYear: number):
  {ok: true; data: BlachaInput} | {ok: false; fields: Record<string, string>} {
  const f: Record<string, string> = {};
  const imie = str(body?.imie).slice(0, 80);
  const nazwisko = str(body?.nazwisko).slice(0, 80);
  const ksywa = str(body?.ksywa).slice(0, 80);
  if (!imie && !ksywa) f.imie = "Podaj imię albo ksywę";
  if (!nazwisko && !ksywa) f.nazwisko = "Podaj nazwisko albo ksywę";
  const num = (v: any) => (str(v) === "" ? null : Number(str(v)));
  const rok = num(body?.rok);
  if (rok !== null && (!Number.isInteger(rok) || rok < 1950 || rok > thisYear)) f.rok = `Rok 1950–${thisYear} albo puste (nieznany)`;
  const nr = num(body?.nr);
  if (nr !== null && (!Number.isInteger(nr) || nr < 1)) f.nr = "Numer to liczba od 1 albo puste";
  if (Object.keys(f).length) return {ok: false, fields: f};
  return {
    ok: true,
    data: {
      imie, nazwisko, ksywa, rok, nr,
      uzasadnienie: str(body?.uzasadnienie).slice(0, 4000),
      klub: str(body?.klub).slice(0, 120),
      zalozycielska: str(body?.zalozycielska).slice(0, 120),
      sp: body?.sp === true,
    },
  };
}
