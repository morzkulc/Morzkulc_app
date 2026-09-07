/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */

import type {Request, Response} from "express";
import {logger} from "firebase-functions/v2";
import {resolveDamageReport} from "../modules/equipment/damage/gear_damage_service";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string}};

export type ResolveGearDamageReportDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
  adminRoleKeys: string[];
};

function norm(v: any): string {
  return String(v == null ? "" : v).trim();
}

/**
 * POST /api/admin/gear-damage/resolve (authenticated, rola_zarzad/rola_kr)
 * Body: {reportId}
 */
export async function handleResolveGearDamageReport(req: Request, res: Response, deps: ResolveGearDamageReportDeps) {
  const {db, sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, requireIdToken, adminRoleKeys} = deps;

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
      const uid = tokenCheck.decoded.uid;

      const userSnap = await db.collection("users_active").doc(uid).get();
      const userData = (userSnap.exists ? userSnap.data() : null) as any;
      const roleKey = norm(userData?.role_key);
      if (!adminRoleKeys.includes(roleKey)) {
        res.status(403).json({error: "Forbidden"});
        return;
      }

      const reportId = norm((req.body as any)?.reportId);
      if (!reportId) {
        res.status(400).json({ok: false, code: "validation_failed", message: "Brak reportId"});
        return;
      }

      const nickname = norm(userData?.profile?.nickname);
      const firstName = norm(userData?.profile?.firstName);
      const lastName = norm(userData?.profile?.lastName);
      const resolvedByName = nickname || [firstName, lastName].filter(Boolean).join(" ") || norm(userData?.email) || uid;

      const result = await resolveDamageReport(db, {reportId, resolvedByUid: uid, resolvedByName});
      if (!result.ok) {
        res.status(result.code === "not_found" ? 404 : 422).json({ok: false, code: result.code, message: result.message});
        return;
      }

      logger.info("resolveGearDamageReport: resolved", {reportId, by: uid});
      res.status(200).json({ok: true});
    } catch (err: any) {
      logger.error("resolveGearDamageReport failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
