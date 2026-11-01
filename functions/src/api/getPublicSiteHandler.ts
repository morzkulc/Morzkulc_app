/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */

/**
 * GET /api/public/site — BEZ logowania. Dane dla statycznej wizytówki klubu na
 * www.morzkulc.pg.gda.pl (i docelowo www.morzkulc.pl): nadchodzące imprezy, zarząd
 * (funkcja + imię i nazwisko + skrzynka funkcyjna), adres klubu, linki do socjali;
 * oraz dla strony kursu (kurs.morzkulc.pl): `kurs` z setup/vars_kurs (buildPublicKurs).
 * Strona klubu dostaje też dane na żywo z aplikacji (public_stats.ts): `stats`, `blachy`,
 * `basen`, `miejsca` — ich błąd nie blokuje reszty odpowiedzi (pole = null).
 *
 * Endpoint publiczny → zwraca WYŁĄCZNIE pola przeznaczone do publikacji (whitelist):
 * z imprez bez contact/description/kierowników, z zarządu bez prywatnych e-maili,
 * żadnych telefonów, KR, kluczy ani finansów.
 *
 * CORS: `Access-Control-Allow-Origin: *` (dane publiczne, bez credentials). NIE lista
 * originów: odpowiedź jest cache'owana w CDN Hosting (max-age=900), który ignoruje
 * `Vary: Origin` — zbuforowana odpowiedź bez ACAO blokowała stronę kursu (20.10.2026).
 * Globalnego ALLOWED_ORIGINS nie rozszerzamy.
 */

import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import {listUpcomingEvents} from "../modules/calendar/events_service";
import {resolveZarzad} from "../modules/setup/function_roles_service";
import {buildPublicKurs} from "../modules/kurs/kurs_public";
import {getPublicLive, getPublicStats} from "../modules/setup/public_stats";

const MAX_EVENTS = 8;

// Zmienne arkusza SETUP (vars_members) z linkami wizytówki; puste = pomijamy.
const SOCIAL_VARS: Array<{key: string; out: string}> = [
  {key: "facebook_url", out: "facebook"},
  {key: "instagram_url", out: "instagram"},
  {key: "kurs_url", out: "kurs"},
  {key: "discord_url", out: "discord"},
];

// Fallbacki, gdy zmiennej nie ma jeszcze w SETUP (zasada: parametr w SETUP, fallback w kodzie).
const SOCIAL_FALLBACK: Record<string, string> = {discord: "https://discord.gg/PNK4dQPm2E"};

// Film „Jak działa Klub” (ten sam plik co w module Klub aplikacji: Storage video/Morzkulc_długi.mp4).
// Zmienna `klub_film_url` w Vars_MEMBERS; fallback = publiczny adres pobierania pliku.
const FILM_FALLBACK = "https://firebasestorage.googleapis.com/v0/b/morzkulc-e9df7.firebasestorage.app/o/video%2FMorzkulc_d%C5%82ugi.mp4?alt=media&token=74b12897-0c45-40bc-9a06-0729837b56ea";

function num(raw: any): number | null {
  const n = Number(String(raw == null ? "" : raw).replace(",", ".").replace(/\s+/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type GetPublicSiteDeps = {
  db: FirebaseFirestore.Firestore;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
};

function httpUrl(raw: any): string {
  const s = String(raw == null ? "" : raw).trim();
  return /^https?:\/\/\S+$/i.test(s) ? s : "";
}

export async function handleGetPublicSite(req: Request, res: Response, deps: GetPublicSiteDeps) {
  const {db, requireAllowedHost, setCorsHeaders} = deps;

  if (!requireAllowedHost(req, res)) return;
  setCorsHeaders(req, res);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  if (req.method !== "GET") {
    res.status(405).json({error: "Method not allowed"});
    return;
  }

  try {
    const soft = <T>(p: Promise<T>, what: string): Promise<T | null> => p.catch((err) => {
      logger.warn("getPublicSite: " + what + " niedostępne", {message: err?.message});
      return null;
    });
    const [events, stateSnap, varsSnap, kursSnap, stats, live, basenVarsSnap] = await Promise.all([
      listUpcomingEvents(db),
      db.collection("service_state").doc("function_roles").get(),
      db.collection("setup").doc("vars_members").get(),
      db.collection("setup").doc("vars_kurs").get(),
      soft(getPublicStats(db), "stats"),
      soft(getPublicLive(db), "live"),
      db.collection("setup").doc("vars_basen").get(),
    ]);
    const basenVars = (basenVarsSnap.exists ? (basenVarsSnap.data() as any)?.vars : null) || {};
    const state = (stateSnap.exists ? (stateSnap.data() as any) : null) || {};
    const vars = (varsSnap.exists ? (varsSnap.data() as any)?.vars : null) || {};

    const zarzad = await resolveZarzad(db, state, vars);

    const social: Record<string, string> = {};
    for (const v of SOCIAL_VARS) {
      const url = httpUrl(vars?.[v.key]?.value) || SOCIAL_FALLBACK[v.out] || "";
      if (url) social[v.out] = url;
    }

    res.setHeader("Cache-Control", "public, max-age=900");
    res.status(200).json({
      ok: true,
      events: events.slice(0, MAX_EVENTS).map((e) => ({
        name: String(e.name || ""),
        startDate: String(e.startDate || ""),
        endDate: String(e.endDate || ""),
        location: String(e.location || ""),
      })),
      zarzad,
      adres: String(vars?.adres_klub?.value || "").trim(),
      // Konto do składek, kursu i basenu (strona Kontakt / Członkostwo); składka semestralna.
      finanse: {
        konto: String(vars?.konto_klubowe?.value || "").replace(/\s+/g, ""),
        bank: String(vars?.bank_klubowy?.value || "").trim(),
        // Składka za okres rozliczeniowy (semestr) i początki semestrów (mm-dd) — grupa „składki” w Vars_MEMBERS.
        skladkaSemestr: num(vars?.["składka"]?.value),
        semestry: [vars?.["semestr_1 start"]?.value, vars?.semestr_2_start?.value]
          .map((v) => String(v == null ? "" : v).trim()).filter((v) => /^\d{2}-\d{2}$/.test(v)),
      },
      basenCennik: {
        godzina: num(basenVars?.basen_cena_za_godzine?.value),
        karnet5: num(basenVars?.basen_cena_karnet_5?.value),
        karnet10: num(basenVars?.basen_cena_karnet_10?.value),
      },
      social,
      film: httpUrl(vars?.klub_film_url?.value) || FILM_FALLBACK,
      kurs: buildPublicKurs(kursSnap.exists ? (kursSnap.data() as any)?.vars : null),
      stats,
      blachy: live?.blachy ?? null,
      basen: live?.basen ?? null,
      miejsca: live?.miejsca ?? null,
    });
  } catch (err: any) {
    logger.error("getPublicSite failed", {message: err?.message, stack: err?.stack});
    res.status(500).json({error: "Server error"});
  }
}
