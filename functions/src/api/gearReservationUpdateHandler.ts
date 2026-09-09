import type {Request, Response} from "express";
import {isIsoDateYYYYMMDD} from "../modules/calendar/calendar_utils";
import {updateGearReservationDates} from "../modules/equipment/bundle/gear_bundle_service";
import {norm} from "../modules/shared/text_utils";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; name?: string}};

export type GearReservationUpdateDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
};

export async function handleGearReservationUpdate(req: Request, res: Response, deps: GearReservationUpdateDeps) {
  const {db, sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, requireIdToken} = deps;

  if (sendPreflight(req, res)) return;
  if (!requireAllowedHost(req, res)) return;
  setCorsHeaders(req, res);

  corsHandler(req, res, async () => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({error: "Method not allowed"});
        return;
      }

      const tokenCheck = await requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }

      const body = (req.body || {}) as any;
      const reservationId = norm(body.reservationId);
      const startDate = norm(body.startDate);
      const endDate = norm(body.endDate);

      if (!reservationId) {
        res.status(400).json({ok: false, code: "validation_failed", message: "Missing reservationId"});
        return;
      }
      if (!isIsoDateYYYYMMDD(startDate) || !isIsoDateYYYYMMDD(endDate) || startDate > endDate) {
        res.status(400).json({ok: false, code: "validation_failed", message: "Invalid startDate/endDate"});
        return;
      }

      const out = await updateGearReservationDates(db, {
        uid: tokenCheck.decoded.uid,
        reservationId,
        startDate,
        endDate,
      });

      if (!out.ok) {
        res.status(400).json(out);
        return;
      }

      res.status(200).json(out);
    } catch (err: any) {
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
