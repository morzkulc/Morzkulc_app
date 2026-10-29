/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */

import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import {fullNameFromUser, resolveZarzad} from "../modules/setup/function_roles_service";
import {BLACHY_COLLECTION, sortRegistry, toPublic} from "../modules/blachy/blachy_registry";
import {canEditRegistry, parseBlachyConfig} from "../modules/blachy/blachy_procedura";
import {ARCHIWUM_DO_ROKU, ARCHIWUM_UWAGA} from "../modules/blachy/blachy_archiwum_2025";
import {todayWarsawIso} from "../modules/shared/date_range_utils";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; name?: string}};

export type GetKlubInfoDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
  adminRoleKeys: string[]; // role widzące dane finansowe (rola_zarzad, rola_kr)
};

/** „8699,01"/„8699.01"/8699 → string w PL (przecinek dziesiętny); pusto → „0". */
function financeAmount(v: any): string {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "0";
  return s.replace(/\./g, ",");
}

export async function handleGetKlubInfo(req: Request, res: Response, deps: GetKlubInfoDeps) {
  const {sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, requireIdToken, db, adminRoleKeys} = deps;

  if (sendPreflight(req, res)) return;
  if (!requireAllowedHost(req, res)) return;
  setCorsHeaders(req, res);

  corsHandler(req, res, async () => {
    try {
      if (req.method !== "GET") {
        res.status(405).json({error: "Method not allowed"});
        return;
      }

      const tokenCheck = await requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }

      const uid = tokenCheck.decoded.uid;

      // Jeden odczyt stanu funkcyjnego + zmiennych setup + KR + dok. użytkownika (rola).
      const [stateSnap, varsSnap, krSnap, userSnap, blachySnap] = await Promise.all([
        db.collection("service_state").doc("function_roles").get(),
        db.collection("setup").doc("vars_members").get(),
        db.collection("users_active").where("role_key", "==", "rola_kr").get(),
        db.collection("users_active").doc(uid).get(),
        db.collection(BLACHY_COLLECTION).get(),
      ]);

      // Dane finansowe (stan konta/gotówki) widzą WYŁĄCZNIE KR i Zarząd —
      // filtrowanie po stronie serwera (pola nieobecne w odpowiedzi, nie tylko
      // nierenderowane) — świadomie NIE rozluźniać (przypomnienie użytkownika
      // 05.09.2026: nie pokazywać stanu konta nikomu poza zarządem/KR).
      const roleKey = userSnap.exists ? String((userSnap.data() as any)?.role_key || "") : "";
      const canSeeFinance = adminRoleKeys.includes(roleKey);
      // Lista osób z kluczami: widoczna dla KAŻDEGO zalogowanego (feedback
      // użytkownika 05.09.2026 — poprzednia bramka do samych ról modułu Klub
      // ukrywała ją też sympatykowi/kursantowi; to nie dane finansowe, sama
      // "kto ma klucze" nie jest wrażliwa).

      const state = (stateSnap.exists ? (stateSnap.data() as any) : null) || {};
      const vars = (varsSnap.exists ? (varsSnap.data() as any)?.vars : null) || {};

      // 1–2) Zarząd: funkcja → operator + skrzynka funkcyjna.
      const zarzad = await resolveZarzad(db, state, vars);

      // 3) Komisja rewizyjna — sort po nazwisku.
      const kr = krSnap.docs
        .map((d) => ({name: fullNameFromUser(d.data() as any, "Członek KR")}))
        .sort((a, b) => a.name.localeCompare(b.name, "pl"));

      // 4) Finanse. Numer konta + bank — dla wszystkich; stany (konto/gotówka) — tylko KR/Zarząd.
      const konto = String(vars?.konto_klubowe?.value || "").trim();
      const bank = String(vars?.bank_klubowy?.value || "").trim();
      const finanse: Record<string, string> = {konto, bank};
      if (canSeeFinance) {
        finanse.stanKonta = financeAmount(vars?.stan_konta?.value);
        finanse.stanGotowki = financeAmount(
          vars?.["stan_kasy_gotówkowej"]?.value ?? vars?.["stan_kasy_gotowkowej"]?.value
        );
      }

      // 4b) Adresy — siedziba klubu + akademik z kluczami (zakładka "Klucze"/nagłówek
      // modułu Klub). akademik_adres: zmienna JUŻ ISTNIEJĄCA w Vars_CZLONKOWIE
      // (współdzielona z usersNotifyAkademikAccessChanged.ts — treść maila o
      // nadaniu/cofnięciu dostępu do akademika). adres_siedziby: nowa, puste
      // dopóki użytkownik nie doda wiersza w arkuszu.
      // adres_klub: adres samego klubu, dodany przez użytkownika 24.09.2026.
      // Fallback na starszą nazwę adres_siedziby — ta nigdy nie została wpisana
      // w arkuszu, ale kod ją czytał, więc zostaje dla zgodności.
      const adresy = {
        siedziba: String(vars?.adres_siedziby?.value || "").trim(),
        akademik: String(vars?.akademik_adres?.value || "").trim(),
        klub: String(vars?.adres_klub?.value || vars?.adres_siedziby?.value || "").trim(),
      };

      // 5) Linki/dokumenty — tylko gdy zmienne istnieją.
      // dysk_url: folder Dysku z regulaminami i statutem. Zgłoszenie użytkownika
      // 23.09.2026 — „ludzie pytają, gdzie znaleźć regulaminy i statut".
      const linki: Record<string, string> = {};
      const statut = String(vars?.statut_url?.value || "").trim();
      const regulamin = String(vars?.regulamin_url?.value || "").trim();
      const dysk = String(vars?.dysk_url?.value || "").trim();
      // regulaminy / infografiki: katalogi Dysku z dodatkowymi materiałami o klubie
      // (zgłoszenie użytkownika 24.09.2026). Każdy dostaje własny kafelek w module
      // Klub — patrz LINK_TILES w klub_module.js.
      const regulaminy = String(vars?.regulaminy?.value || "").trim();
      const infografiki = String(vars?.infografiki?.value || "").trim();
      const klucze = String(vars?.klucze?.value || "").trim();
      if (statut) linki.statut = statut;
      if (regulamin) linki.regulamin = regulamin;
      if (dysk) linki.dysk = dysk;
      if (regulaminy) linki.regulaminy = regulaminy;
      if (infografiki) linki.infografiki = infografiki;
      if (klucze) linki.klucze = klucze;

      // 6) Osoby z kluczami do siedziby / dostępem do akademika — widoczne dla
      // każdego zalogowanego (patrz komentarz przy canSeeKeys wyżej — usunięty
      // 05.09.2026). Wyświetlanie: ksywka jeśli jest (inaczej imię+nazwisko);
      // telefon zawsze osobną kolumną (żeby dało się skontaktować w sprawie
      // odbioru kluczy).
      let kluczeOsoby: Array<{name: string; phone: string | null; hasClubKeys: boolean; hasAkademikAccess: boolean}> | undefined;
      {
        const [withKeysSnap, withAkademikSnap] = await Promise.all([
          db.collection("users_active").where("admin.hasClubKeys", "==", true).get(),
          db.collection("users_active").where("admin.hasAkademikAccess", "==", true).get(),
        ]);

        type Entry = {profile: any; hasClubKeys: boolean; hasAkademikAccess: boolean};
        const byUid = new Map<string, Entry>();
        withKeysSnap.forEach((d) => {
          const u = d.data() as any;
          byUid.set(d.id, {profile: u?.profile || {}, hasClubKeys: true, hasAkademikAccess: false});
        });
        withAkademikSnap.forEach((d) => {
          const u = d.data() as any;
          const existing = byUid.get(d.id);
          if (existing) existing.hasAkademikAccess = true;
          else byUid.set(d.id, {profile: u?.profile || {}, hasClubKeys: false, hasAkademikAccess: true});
        });

        kluczeOsoby = Array.from(byUid.values())
          .map((entry) => {
            const p = entry.profile;
            const nickname = String(p?.nickname || "").trim();
            const fullName = [p?.firstName, p?.lastName].map((s: any) => String(s || "").trim()).filter(Boolean).join(" ").trim();
            const phone = String(p?.phone || "").trim();
            const name = nickname || fullName || "(bez nazwy)";
            return {
              name,
              phone: phone || null,
              hasClubKeys: entry.hasClubKeys,
              hasAkademikAccess: entry.hasAkademikAccess,
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name, "pl"));
      }

      res.status(200).json({
        ok: true,
        zarzad,
        kr,
        finanse,
        adresy,
        linki,
        ...(kluczeOsoby ? {kluczeOsoby} : {}),
        // Rejestr Blach — jawny dla zalogowanych (regulamin § 6 pkt 2), bez e-maili.
        blachy: sortRegistry(blachySnap.docs.map((d) => toPublic(d.id, d.data()))),
        blachyArchiwum: {doRoku: ARCHIWUM_DO_ROKU, uwaga: ARCHIWUM_UWAGA},
        canEditBlachy: canEditRegistry(parseBlachyConfig(vars, todayWarsawIso()),
          String((userSnap.data() as any)?.email || tokenCheck.decoded.email || ""), canSeeFinance),
      });
    } catch (err: any) {
      logger.error("getKlubInfo failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
