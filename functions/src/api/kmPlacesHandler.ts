/**
 * kmPlacesHandler.ts
 *
 * GET /kmPlaces?all=1   — cały słownik (formularz filtruje podpowiedzi lokalnie)
 * GET /kmPlaces?q=rad    — podpowiedzi z backendu (array-contains na searchTerms; starsi klienci)
 *
 * Query params:
 *   all?   — "1": zwróć cały słownik, q/limit ignorowane
 *   q      — zapytanie (min 2 znaki)
 *   limit? — max wyników (domyślnie 10, max 20)
 */

import type {Request, Response} from "express";
import {listKmPlaces, searchKmPlaces} from "../modules/km/km_places_service";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; name?: string}};

export type KmPlacesDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
};

export async function handleKmPlaces(
  req: Request,
  res: Response,
  deps: KmPlacesDeps
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

      if (String(req.query.all || "") === "1") {
        const places = await listKmPlaces(deps.db);
        res.status(200).json({ok: true, places, count: places.length});
        return;
      }

      const q = String(req.query.q || "").trim();
      const limitRaw = parseInt(String(req.query.limit || "10"), 10);
      const limit = Math.min(20, Math.max(1, Number.isNaN(limitRaw) ? 10 : limitRaw));

      if (q.length < 2) {
        res.status(200).json({ok: true, places: [], count: 0});
        return;
      }

      const places = await searchKmPlaces(deps.db, q, limit);

      res.status(200).json({ok: true, places, count: places.length});
    } catch (err: any) {
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
