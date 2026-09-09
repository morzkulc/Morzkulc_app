/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */

import type {Request, Response} from "express";
import {logger} from "firebase-functions/v2";
import {norm} from "../modules/shared/text_utils";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; name?: string}};

export type GetAdminGearDamageReportsDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
  adminRoleKeys: string[];
};

function tsToIso(v: any): string | null {
  if (!v) return null;
  if (typeof v?.toDate === "function") return v.toDate().toISOString();
  return null;
}

type GearDamageReportItem = {
  id: string;
  category: string;
  itemId: string;
  itemNumber: string;
  itemLabel: string;
  severity: string;
  description: string;
  reporterName: string;
  createdAt: string | null;
  photoUrls: string[];
};

export async function handleGetAdminGearDamageReports(req: Request, res: Response, deps: GetAdminGearDamageReportsDeps) {
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
      const userSnap = await db.collection("users_active").doc(uid).get();
      const roleKey = norm((userSnap.data() as any)?.role_key);
      if (!adminRoleKeys.includes(roleKey)) {
        res.status(403).json({error: "Forbidden"});
        return;
      }

      // reporterName i photoUrls (Firebase download-token URL, nie signed URL —
      // patrz gear_damage_service.ts) są już zdenormalizowane na dokumencie w
      // chwili zgłoszenia, więc bez dodatkowych lookupów tutaj.
      const damageSnap = await db.collection("gear_damage_reports")
        .where("status", "==", "open")
        .get();

      const items: GearDamageReportItem[] = damageSnap.docs.map((d) => {
        const data = d.data() as any;
        return {
          id: d.id,
          category: norm(data?.category),
          itemId: norm(data?.itemId),
          itemNumber: norm(data?.itemNumber),
          itemLabel: norm(data?.itemLabel),
          severity: norm(data?.severity),
          description: norm(data?.description),
          reporterName: norm(data?.reporterName),
          createdAt: tsToIso(data?.createdAt),
          photoUrls: Array.isArray(data?.photoUrls) ? data.photoUrls.map((u: any) => norm(u)).filter(Boolean) : [],
        };
      });

      // Kolejność wg wagi: trup (💀) najpilniejsze, potem "to się wyklepie" (👎),
      // "da się używać" (👍) na końcu.
      const severityRank: Record<string, number> = {dead: 0, repair: 1, usable: 2};
      items.sort((a, b) => {
        const rankDiff = (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3);
        if (rankDiff !== 0) return rankDiff;
        return (a.createdAt || "").localeCompare(b.createdAt || "");
      });

      res.status(200).json({ok: true, count: items.length, items});
    } catch (err: any) {
      logger.error("getAdminGearDamageReports failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
