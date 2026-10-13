/**
 * kmMyStatsHandler.ts
 *
 * GET /kmMyStats
 *
 * Zwraca agregaty zalogowanego użytkownika z kolekcji km_user_stats.
 * Dane gotowe — odczyt O(1), brak przeliczania po stronie serwera.
 *
 * ?club=1 — dodatkowo `club`: bieżący rok na tle klubu + moje miesiące (km_club_stats.ts).
 * Czyta wszystkie km_user_stats (pola uid, years) — tylko dla zakładki „Moje statystyki”.
 */

import type {Request, Response} from "express";
import {getUserKmStats} from "../modules/km/km_log_service";
import {getKmClubStats} from "../modules/km/km_club_stats";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; name?: string}};

export type KmMyStatsDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
};

export async function handleKmMyStats(
  req: Request,
  res: Response,
  deps: KmMyStatsDeps
): Promise<void> {
  if (deps.sendPreflight(req, res)) return;
  if (!deps.requireAllowedHost(req, res)) return;
  deps.setCorsHeaders(req, res);

  deps.corsHandler(req, res, async () => {
    if (req.method !== "GET") {
      res.status(405).json({error: "Method not allowed"});
      return;
    }

    try {
      const tokenCheck = await deps.requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }
      const uid = tokenCheck.decoded.uid;

      const withClub = String(req.query?.club || "") === "1";
      const [stats, club] = await Promise.all([
        getUserKmStats(deps.db, uid),
        withClub ? getKmClubStats(deps.db, uid, new Date().getFullYear()) : Promise.resolve(undefined),
      ]);

      res.status(200).json({ok: true, stats, ...(club ? {club} : {})});
    } catch (err: any) {
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
