import {buildPublicKurs, PublicKurs} from "./kurs_public";
import {cenaFor, przelewTitle} from "./kurs_zgloszenia";

/**
 * Konfiguracja zapisów z arkusza SETUP: dane kursu z Vars_KURS (te same, co na stronie)
 * oraz konto klubowe z Vars_CZLONKOWIE (konto_klubowe / bank_klubowy — jak w boxie Klub).
 */
export type KursSignupConfig = {
  kurs: PublicKurs;
  konto: string;
  bank: string;
  /** Link do aplikacji w mailach (vars_members.link_aplikacji — ten sam co w innych mailach). */
  appUrl: string;
  /** Strona kursu (vars_members.kurs_url); pusta = linki pominięte w mailu. */
  kursUrl: string;
};

export async function loadKursSignupConfig(db: FirebaseFirestore.Firestore): Promise<KursSignupConfig> {
  const [kursSnap, membersSnap] = await Promise.all([
    db.collection("setup").doc("vars_kurs").get(),
    db.collection("setup").doc("vars_members").get(),
  ]);
  const kurs = buildPublicKurs(kursSnap.exists ? (kursSnap.data() as any)?.vars : null);
  const mv = membersSnap.exists ? (membersSnap.data() as any)?.vars : null;
  return {
    kurs,
    konto: String(mv?.konto_klubowe?.value || "").trim(),
    bank: String(mv?.bank_klubowy?.value || "").trim(),
    appUrl: String(mv?.link_aplikacji?.value || "").trim() || "https://app.morzkulc.pl/",
    kursUrl: String(mv?.kurs_url?.value || "").trim(),
  };
}

/**
 * Tryb demo (kurs_zapisy_demo_do w Vars_KURS): do tej daty włącznie formularz działa
 * niezależnie od statusu zapisów, a zgłoszenia dostają demo:true — po teście usuwa je
 * task kurs.purgeDemo (baza + arkusz członków).
 */
export function demoActive(cfg: KursSignupConfig, todayIso: string): boolean {
  const until = typeof cfg.kurs.zapisyDemoDo === "string" ? cfg.kurs.zapisyDemoDo : "";
  return Boolean(until) && todayIso <= until;
}

export function zapisyOtwarte(cfg: KursSignupConfig, todayIso = new Date().toISOString().slice(0, 10)): boolean {
  return cfg.kurs.zapisyStatus === "otwarte" || cfg.kurs.zapisyStatus === "rezerwowa" || demoActive(cfg, todayIso);
}

export type PrzelewInfo = {
  konto: string;
  bank: string;
  tytul: string;
  zadatek: number | null;
  cena: number | null;
  terminDoplaty: string;
};

/** Dane do przelewu dla konkretnego zgłoszenia (strona, mail, panel). */
export function przelewInfo(cfg: KursSignupConfig, z: {edycja: string; form: {imie: string; nazwisko: string; student: boolean}}): PrzelewInfo {
  const n = (v: any) => (typeof v === "number" ? v : null);
  return {
    konto: cfg.konto,
    bank: cfg.bank,
    tytul: przelewTitle(z.edycja, z.form.imie, z.form.nazwisko),
    zadatek: n(cfg.kurs.zadatek),
    cena: cenaFor(z.form.student, n(cfg.kurs.cena), n(cfg.kurs.cenaStudent)),
    terminDoplaty: typeof cfg.kurs.terminDoplaty === "string" ? cfg.kurs.terminDoplaty : "",
  };
}
