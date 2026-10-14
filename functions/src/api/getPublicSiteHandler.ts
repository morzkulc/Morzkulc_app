/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */

/**
 * GET /api/public/site — BEZ logowania. Dane dla statycznej wizytówki klubu na
 * www.morzkulc.pg.gda.pl (i docelowo www.morzkulc.pl): nadchodzące imprezy, zarząd
 * (funkcja + imię i nazwisko + skrzynka funkcyjna), adres klubu, linki do socjali.
 *
 * Endpoint publiczny → zwraca WYŁĄCZNIE pola przeznaczone do publikacji (whitelist):
 * z imprez bez contact/description/kierowników, z zarządu bez prywatnych e-maili,
 * żadnych telefonów, KR, kluczy ani finansów.
 *
 * CORS: własna lista originów (wizytówki), globalnego ALLOWED_ORIGINS nie rozszerzamy,
 * żeby nie otwierać pozostałych endpointów na obce strony.
 */

import type {Request, Response} from "express";
import {logger} from "firebase-functions/v2";
import {listUpcomingEvents} from "../modules/calendar/events_service";
import {resolveZarzad} from "../modules/setup/function_roles_service";

export const PUBLIC_SITE_ORIGINS = new Set<string>([
  "http://www.morzkulc.pg.gda.pl",
  "https://www.morzkulc.pg.gda.pl",
  "http://morzkulc.pg.gda.pl",
  "https://morzkulc.pg.gda.pl",
  "https://www.morzkulc.pl",
  "https://morzkulc.pl",
]);

const MAX_EVENTS = 8;

// Zmienne arkusza SETUP (vars_members) z linkami wizytówki; puste = pomijamy.
const SOCIAL_VARS: Array<{key: string; out: string}> = [
  {key: "facebook_url", out: "facebook"},
  {key: "instagram_url", out: "instagram"},
  {key: "kurs_url", out: "kurs"},
];

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
  const origin = String(req.headers.origin || "");
  if (PUBLIC_SITE_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
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
    const [events, stateSnap, varsSnap] = await Promise.all([
      listUpcomingEvents(db),
      db.collection("service_state").doc("function_roles").get(),
      db.collection("setup").doc("vars_members").get(),
    ]);
    const state = (stateSnap.exists ? (stateSnap.data() as any) : null) || {};
    const vars = (varsSnap.exists ? (varsSnap.data() as any)?.vars : null) || {};

    const zarzad = await resolveZarzad(db, state, vars);

    const social: Record<string, string> = {};
    for (const v of SOCIAL_VARS) {
      const url = httpUrl(vars?.[v.key]?.value);
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
      social,
    });
  } catch (err: any) {
    logger.error("getPublicSite failed", {message: err?.message, stack: err?.stack});
    res.status(500).json({error: "Server error"});
  }
}
