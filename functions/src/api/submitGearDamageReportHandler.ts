/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */

import type {Request, Response} from "express";
import * as admin from "firebase-admin";
import {logger} from "firebase-functions/v2";
import {createDamageReport, isSupportedDamageCategory} from "../modules/equipment/damage/gear_damage_service";

/** Kolejkuje job serwisowy (fire-and-forget z gwarancją zapisu joba) — ten sam
 * wzorzec co adminGearReservationCancelHandler.ts. */
async function enqueueJob(db: FirebaseFirestore.Firestore, taskId: string, payload: Record<string, any>): Promise<void> {
  const jobRef = db.collection("service_jobs").doc();
  await jobRef.set({
    id: jobRef.id,
    taskId,
    payload,
    status: "queued",
    attempts: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; name?: string}};

export type SubmitGearDamageReportDeps = {
  db: FirebaseFirestore.Firestore;
  bucket: any;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
  memberRoleKeys: string[];
};

function norm(v: any): string {
  return String(v == null ? "" : v).trim();
}

/**
 * POST /api/gear/damage-report (authenticated, memberRoleKeys — kandydat/czlonek/kr/zarzad)
 * Body: {category, itemId, severity: "usable"|"repair"|"dead", description, photos?: [{data, mimeType}]}
 */
export async function handleSubmitGearDamageReport(req: Request, res: Response, deps: SubmitGearDamageReportDeps) {
  const {db, bucket, sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, requireIdToken, memberRoleKeys} = deps;

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

      const body = (req.body || {}) as any;
      const category = norm(body.category).toLowerCase();
      if (!isSupportedDamageCategory(category)) {
        res.status(400).json({ok: false, code: "validation_failed", message: `Nieobsługiwana kategoria: ${category}`});
        return;
      }

      const itemId = norm(body.itemId);
      const severity = norm(body.severity); // walidacja/domyślna wartość w createDamageReport
      const description = norm(body.description);
      const photosRaw = Array.isArray(body.photos) ? body.photos : [];
      const photos = photosRaw.slice(0, 2).map((p: any) => ({data: norm(p?.data), mimeType: norm(p?.mimeType)}));

      const nickname = norm(userData?.profile?.nickname);
      const firstName = norm(userData?.profile?.firstName);
      const lastName = norm(userData?.profile?.lastName);
      const reporterName = nickname || [firstName, lastName].filter(Boolean).join(" ") || norm(userData?.email);

      const result = await createDamageReport(db, bucket, memberRoleKeys, {
        uid,
        roleKey,
        reporterName,
        reporterEmail: norm(userData?.email || tokenCheck.decoded.email),
        category,
        itemId,
        severity,
        description,
        photos,
      });

      if (!result.ok) {
        const status = result.code === "forbidden" ? 403 : result.code === "item_not_found" ? 404 : 422;
        res.status(status).json({ok: false, code: result.code, message: result.message});
        return;
      }

      logger.info("submitGearDamageReport: created", {reportId: result.data.reportId, category, itemId, severity, uid});

      // Fire-and-forget: powiadomienie zarządu mailem (feedback użytkownika 07.09.2026 —
      // panel sam w sobie to za mało, zgłoszenie nie może "po cichu" blokować sprzętu).
      // Błąd enqueue NIE cofa zgłoszenia — użytkownik i tak dostał potwierdzenie zapisu.
      try {
        await enqueueJob(db, "gear.notifyDamageReport", {reportId: result.data.reportId});
      } catch (e: any) {
        logger.error("submitGearDamageReport: enqueue notify failed", {reportId: result.data.reportId, message: e?.message});
      }

      res.status(200).json({ok: true, reportId: result.data.reportId});
    } catch (err: any) {
      logger.error("submitGearDamageReport failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
