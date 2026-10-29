/**
 * Procedura nadawania Blach (regulamin v3.2 §3–§6): konfiguracja z SETUP (Vars_CZLONKOWIE →
 * setup/vars_members), fazy roku, miejsca w Kapitule, klucze kandydatów, zestawienie dla Kapituły.
 *
 * Kolekcje:
 *  - blachy_procedura/{rok}         — stan roku: znaczniki maili, zatwierdzenie/zwrot Zarządu, ogłoszenie, protokół,
 *  - blachy_nominacje/{id}          — zgłoszenia (tajne: autor + Kapituła),
 *  - blachy_kandydatury/{rok}_{key} — zgłoszenia zebrane per kandydat + głosowanie,
 *  - blachy_kandydatury/{id}/tajne/wynik — WYŁĄCZNIE sumy TAK/NIE (bez powiązania osoba↔głos).
 */
import {minusDays} from "../shared/date_range_utils";
import {personKey} from "./blachy_registry";
import {ARCHIWUM_MAX_NR} from "./blachy_archiwum_2025";

export const PROCEDURA_COLLECTION = "blachy_procedura";
export const NOMINACJE_COLLECTION = "blachy_nominacje";
export const KANDYDATURY_COLLECTION = "blachy_kandydatury";

/** §2 pkt 1 — obszary zasług (równorzędne). */
export const OBSZARY = [
  "Działalność organizacyjna",
  "Działalność szkoleniowa",
  "Budowanie społeczności",
  "Rozwój kajakarstwa",
  "Współpraca międzyklubowa",
];

/** Role, które mogą zgłaszać kandydatów (decyzja D1: aktualni członkowie). */
export const NOMINUJACE_ROLE = ["rola_czlonek", "rola_zarzad", "rola_kr"];

/** Numeracja nowych blach: kolejne po archiwum klubowym (00–39 → od 40). */
export const PIERWSZY_NUMER = ARCHIWUM_MAX_NR + 1;

/**
 * Po tylu dniach od ogłoszenia (termin na zastrzeżenia do KR, §6 pkt 3) usuwamy wszystkie dane o
 * zgłoszonych — nominacje, kandydatury, sumy głosów (§6 pkt 2). Zostają tylko wyróżnieni w Rejestrze.
 */
export const DNI_DO_USUNIECIA = 14;

export const SEATS = 5;
export const PROG_WYBORU = 4;

export type Seat = {seat: number; czlonek: string; zastepca: string};

export type BlachyConfig = {
  wlaczona: boolean;
  edycjaZarzad: boolean;
  rok: number;
  nominacjeOd: string;
  nominacjeDo: string;
  weryfikacjaDo: string;
  glosowanieDo: string;
  zatwierdzenieDo: string;
  przypomnienieDni: number;
  kapitula: Seat[];
  przewodniczacy: string;
};

const str = (v: any) => String(v == null ? "" : v).trim();
const email = (v: any) => str(v).toLowerCase();
const bool = (v: any) => ["true", "tak", "1", "yes"].includes(str(v).toLowerCase());

/** „09-01" / „01.09" / „2027-09-01" → „{rok}-09-01"; inaczej "". */
export function dayOfYear(raw: any, rok: number): string {
  const s = str(raw);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${rok}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return `${rok}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = /^(\d{1,2})\.(\d{1,2})\.?$/.exec(s);
  if (m) return `${rok}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}

/** Konfiguracja z setup/vars_members.vars (zmienne blachy_*). Brakujące terminy = harmonogram regulaminu §3 pkt 1, §5 pkt 8. */
export function parseBlachyConfig(vars: Record<string, any> | null | undefined, todayIso: string): BlachyConfig {
  const v = (k: string) => vars?.[k]?.value;
  const rok = Number(todayIso.slice(0, 4));
  const d = (k: string, def: string) => dayOfYear(v(k), rok) || `${rok}-${def}`;
  const kapitula: Seat[] = [];
  for (let i = 1; i <= SEATS; i++) {
    kapitula.push({seat: i, czlonek: email(v(`blachy_kapitula_${i}`)), zastepca: email(v(`blachy_kapitula_zastepca_${i}`))});
  }
  const dni = Number(str(v("blachy_przypomnienie_dni")));
  return {
    wlaczona: bool(v("blachy_procedura")),
    // Brak zmiennej = Zarząd/KR edytują Rejestr (okres uzupełniania danych); FALSE = tylko Kapituła.
    edycjaZarzad: str(v("blachy_edycja_zarzad")) === "" ? true : bool(v("blachy_edycja_zarzad")),
    rok,
    nominacjeOd: d("blachy_nominacje_od", "09-01"),
    nominacjeDo: d("blachy_nominacje_do", "09-30"),
    weryfikacjaDo: d("blachy_weryfikacja_do", "10-15"),
    glosowanieDo: d("blachy_glosowanie_do", "10-31"),
    zatwierdzenieDo: d("blachy_zatwierdzenie_do", "11-15"),
    przypomnienieDni: Number.isInteger(dni) && dni > 0 ? dni : 7,
    kapitula,
    przewodniczacy: email(v("blachy_kapitula_przewodniczacy")),
  };
}

export type Faza = "wylaczona" | "przed" | "nominacje" | "weryfikacja" | "glosowanie" | "zatwierdzenie" | "po";

export function faza(cfg: BlachyConfig, todayIso: string): Faza {
  if (!cfg.wlaczona) return "wylaczona";
  if (todayIso < cfg.nominacjeOd) return "przed";
  if (todayIso <= cfg.nominacjeDo) return "nominacje";
  if (todayIso <= cfg.weryfikacjaDo) return "weryfikacja";
  if (todayIso <= cfg.glosowanieDo) return "glosowanie";
  if (todayIso <= cfg.zatwierdzenieDo) return "zatwierdzenie";
  return "po";
}

export function dzienPrzypomnienia(cfg: BlachyConfig): string {
  return minusDays(cfg.nominacjeDo, cfg.przypomnienieDni);
}

/** Wszystkie e-maile składu (członkowie, zastępcy, przewodniczący) — bez duplikatów. */
export function kapitulaEmails(cfg: BlachyConfig): string[] {
  const all = [...cfg.kapitula.flatMap((s) => [s.czlonek, s.zastepca]), cfg.przewodniczacy].filter(Boolean);
  return [...new Set(all)];
}

export function isKapitula(cfg: BlachyConfig, mail: string): boolean {
  return Boolean(mail) && kapitulaEmails(cfg).includes(email(mail));
}

/** Kto edytuje Rejestr Blach: Kapituła zawsze; Zarząd/KR tylko przy blachy_edycja_zarzad ≠ FALSE (uzupełnianie danych). */
export function canEditRegistry(cfg: BlachyConfig, mail: string, isAdminRole: boolean): boolean {
  return isKapitula(cfg, mail) || (isAdminRole && cfg.edycjaZarzad);
}

/**
 * Kto głosuje na danym miejscu (§5 pkt 2): członek, a gdy zgłosił konflikt interesów — zastępca;
 * gdy i on nie może — miejsce puste (null).
 */
export function seatVoters(cfg: BlachyConfig, wylaczeni: string[]): Array<{seat: number; email: string | null}> {
  const excluded = new Set(wylaczeni.map(email));
  const ok = (e: string) => Boolean(e) && !excluded.has(e);
  return cfg.kapitula.map((s) => ({seat: s.seat, email: ok(s.czlonek) ? s.czlonek : ok(s.zastepca) ? s.zastepca : null}));
}

/** Klucz kandydata: konto w aplikacji albo znormalizowane imię+nazwisko (osoby spoza listy). */
export function candidateKey(k: {uid?: string; imie?: string; nazwisko?: string; ksywa?: string}): string {
  if (str(k.uid)) return `u_${str(k.uid)}`;
  const pk = personKey(str(k.imie), str(k.nazwisko));
  const base = pk !== "|" ? pk : `ksywa|${str(k.ksywa).toLowerCase()}`;
  return `n_${base.replace(/[^a-z0-9|]+/g, "-").replace(/\|/g, "_")}`;
}

export type Kandydat = {uid: string; imie: string; nazwisko: string; ksywa: string; klub: string; email: string};

export type NominacjaInput = {kandydat: Kandydat; obszary: string[]; zaslugi: string; uzasadnienie: string};

/** Walidacja formularza zgłoszenia (§3 pkt 3). */
export function validateNominacja(body: any):
  {ok: true; data: NominacjaInput} | {ok: false; fields: Record<string, string>} {
  const f: Record<string, string> = {};
  const k = body?.kandydat || {};
  const kandydat: Kandydat = {
    uid: str(k.uid).slice(0, 128),
    imie: str(k.imie).slice(0, 80),
    nazwisko: str(k.nazwisko).slice(0, 80),
    ksywa: str(k.ksywa).slice(0, 80),
    klub: str(k.klub).slice(0, 120),
    email: email(k.email).slice(0, 160),
  };
  if (!kandydat.uid && !kandydat.ksywa && !(kandydat.imie && kandydat.nazwisko)) f.kandydat = "Wybierz osobę z listy albo podaj imię i nazwisko";
  if (kandydat.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(kandydat.email)) f.email = "Niepoprawny e-mail kandydata";
  const obszary = (Array.isArray(body?.obszary) ? body.obszary : []).map(str).filter((o: string) => OBSZARY.includes(o));
  const zaslugi = str(body?.zaslugi).slice(0, 8000);
  const uzasadnienie = str(body?.uzasadnienie).slice(0, 8000);
  if (zaslugi.length < 20) f.zaslugi = "Opisz konkretne zasługi kandydata (min. 20 znaków)";
  if (uzasadnienie.length < 20) f.uzasadnienie = "Uzasadnij nominację (min. 20 znaków)";
  if (Object.keys(f).length) return {ok: false, fields: f};
  return {ok: true, data: {kandydat, obszary: [...new Set<string>(obszary)], zaslugi, uzasadnienie}};
}

export function kandydatLabel(k: Partial<Kandydat>): string {
  const full = [str(k.imie), str(k.nazwisko)].filter(Boolean).join(" ");
  const ks = str(k.ksywa);
  const base = full ? (ks ? `${full} „${ks}”` : full) : ks;
  return str(k.klub) ? `${base} (${str(k.klub)})` : base;
}

/** Następny numer Blachy: max(numer ostatniej z archiwum, największy numer w Rejestrze) + 1. */
export function nextNumer(nrs: Array<number | null | undefined>): number {
  const max = Math.max(PIERWSZY_NUMER - 1, ...nrs.filter((n): n is number => typeof n === "number"));
  return max + 1;
}
