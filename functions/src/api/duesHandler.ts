import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import {getAppVars} from "../modules/setup/app_vars";
import {todayWarsawIso} from "../modules/shared/date_range_utils";
import {fullName} from "../modules/shared/user_display";
import {
  DuesClientError, cancelOwnDuesOrder, computeDuesStatus, createDuesOrder, duesPreviews, getOpenDuesOrder, paidUntilAfterPayment,
} from "../modules/dues/dues_service";
import {createSuspensionRequest, lastSuspensionRequestIso, suspensionInfo} from "../modules/dues/dues_suspension";

type Deps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: (req: Request, res: Response, next: () => void) => void;
  requireIdToken: (req: Request) => Promise<{error: string} | {decoded: any}>;
};

function publicOrder(o: any) {
  if (!o) return null;
  return {
    id: o.id, kind: o.kind, semesters: o.semesters, amountPln: o.amountPln, transferTitle: o.transferTitle,
    status: o.status, writeBackStatus: o.writeBack?.status || null,
    createdAt: o.createdAt?.toDate ? o.createdAt.toDate().toISOString() : null,
  };
}

/**
 * GET  /api/dues — stan składek/wpisowego zalogowanego + podgląd nowej daty + otwarte zgłoszenie.
 * POST /api/dues — {action: "create", semesters} zgłoszenie wpłaty (wpisowe: zawsze 2 semestry)
 *                  {action: "cancel", orderId} anulowanie własnego niepotwierdzonego zgłoszenia.
 *                  {action: "suspend_request", message?} prośba do Zarządu o zawieszenie członkostwa (tylko mail).
 */
export async function handleDues(req: Request, res: Response, deps: Deps): Promise<void> {
  if (deps.sendPreflight(req, res)) return;
  if (!deps.requireAllowedHost(req, res)) return;
  deps.setCorsHeaders(req, res);

  deps.corsHandler(req, res, async () => {
    try {
      const tokenCheck = await deps.requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }
      const uid = tokenCheck.decoded.uid;
      const userSnap = await deps.db.collection("users_active").doc(uid).get();
      if (!userSnap.exists) {
        res.status(403).json({error: "User not found"});
        return;
      }
      const userData = userSnap.data() as any;

      if (req.method === "GET") {
        const vars = await getAppVars(deps.db);
        const today = todayWarsawIso();
        const status = computeDuesStatus(userData, vars, today);
        const previews = status.canOrder ? duesPreviews(status, vars.semesterEnds, today) : [];
        const [order, lastSuspIso] = status.applicable ?
          await Promise.all([getOpenDuesOrder(deps.db, uid), lastSuspensionRequestIso(deps.db, uid)]) : [null, ""];
        const suspension = suspensionInfo(userData, vars, lastSuspIso, today);
        // Data „opłacone do” po zaksięgowaniu tego zgłoszenia (po potwierdzeniu — ta wyliczona przez skarbnika).
        const paidUntilAfter = order ? (order.writeBack?.to || order.targetPaidUntil ||
          (vars.semesterEnds.length ? paidUntilAfterPayment(status.paidUntil, order.semesters, today, vars.semesterEnds) : "")) : "";
        res.status(200).json({ok: true, status, previews, order: order ? {...publicOrder(order), paidUntilAfter} : null, suspension});
        return;
      }

      if (req.method !== "POST") {
        res.status(405).json({error: "Method not allowed"});
        return;
      }
      const body = req.body || {};
      const action = String(body.action || "");
      if (action === "create") {
        const order = await createDuesOrder(deps.db, {
          uid, userData, userName: fullName(userData) || String(userData?.email || uid), semesters: body.semesters,
        });
        res.status(200).json({ok: true, order: publicOrder({...order, createdAt: null})});
        return;
      }
      if (action === "suspend_request") {
        const vars = await getAppVars(deps.db);
        await createSuspensionRequest(deps.db, vars, {
          uid, userData, userName: fullName(userData) || String(userData?.email || uid), message: body.message,
        });
        res.status(200).json({ok: true});
        return;
      }
      if (action === "cancel") {
        const orderId = String(body.orderId || "").trim();
        if (!orderId) throw new DuesClientError("Brakuje orderId.");
        await cancelOwnDuesOrder(deps.db, {uid, orderId});
        res.status(200).json({ok: true});
        return;
      }
      res.status(400).json({error: "Nieznana akcja."});
    } catch (err: any) {
      if (err instanceof DuesClientError) {
        res.status(400).json({error: err.message});
        return;
      }
      logger.error("dues failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
