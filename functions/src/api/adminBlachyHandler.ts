/* eslint-disable require-jsdoc */
import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import {BLACHY_COLLECTION, isArchiwum, toPublic, validateBlachaInput} from "../modules/blachy/blachy_registry";
import {norm} from "../modules/shared/text_utils";
import {canEditRegistry, parseBlachyConfig} from "../modules/blachy/blachy_procedura";
import {todayWarsawIso} from "../modules/shared/date_range_utils";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string}};

export type AdminBlachyDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
  adminRoleKeys: string[];
};

/**
 * POST /api/admin/blachy — Rejestr Blach: Kapituła, a Zarząd/KR gdy blachy_edycja_zarzad ≠ FALSE:
 *  {action: "add", data}       — nowa blacha (także osoba spoza klubu),
 *  {action: "update", id, data} — poprawka wpisu (rok, numer, uzasadnienie, klub…),
 *  {action: "delete", id}      — usunięcie BŁĘDNEGO wpisu (np. pomyłka w arkuszu).
 * Wpisy z oficjalnego archiwum klubowego (zrodlo archiwum_2025) są nieedytowalne.
 * E-mail / ID członka / źródło wpisu nie są edytowalne — służą dopasowaniu przy syncu arkusza.
 */
export async function handleAdminBlachy(req: Request, res: Response, deps: AdminBlachyDeps) {
  const {sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, db, requireIdToken, adminRoleKeys} = deps;
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
      const [userSnap, varsSnap] = await Promise.all([
        db.collection("users_active").doc(uid).get(),
        db.collection("setup").doc("vars_members").get(),
      ]);
      const cfg = parseBlachyConfig((varsSnap.data() as any)?.vars, todayWarsawIso());
      const mail = norm((userSnap.data() as any)?.email || tokenCheck.decoded.email).toLowerCase();
      if (!canEditRegistry(cfg, mail, adminRoleKeys.includes(norm((userSnap.data() as any)?.role_key)))) {
        res.status(403).json({error: "Forbidden"});
        return;
      }
      const by = norm(tokenCheck.decoded.email) || uid;
      const action = norm(req.body?.action);
      const col = db.collection(BLACHY_COLLECTION);
      const ts = admin.firestore.FieldValue.serverTimestamp();

      if (action === "delete" || action === "update") {
        const id = norm(req.body?.id);
        const ref = id ? col.doc(id) : null;
        const snap = ref ? await ref.get() : null;
        if (!ref || !snap?.exists) {
          res.status(404).json({error: "Nie ma takiego wpisu"});
          return;
        }
        if (isArchiwum(snap.data())) {
          res.status(409).json({error: "Wpis z archiwum klubowego — bez edycji"});
          return;
        }
        if (action === "delete") {
          await ref.delete();
          logger.info("adminBlachy: delete", {id, by});
          res.status(200).json({ok: true});
          return;
        }
        const v = validateBlachaInput(req.body?.data, new Date().getFullYear());
        if (!v.ok) {
          res.status(400).json({error: "Popraw pola", fields: v.fields});
          return;
        }
        await ref.update({...v.data, updatedAt: ts, updatedBy: by});
        res.status(200).json({ok: true, blacha: toPublic(id, v.data)});
        return;
      }

      if (action === "add") {
        const v = validateBlachaInput(req.body?.data, new Date().getFullYear());
        if (!v.ok) {
          res.status(400).json({error: "Popraw pola", fields: v.fields});
          return;
        }
        const ref = col.doc();
        await ref.set({...v.data, honorowa: false, email: "", memberId: null, zrodlo: "aplikacja", createdAt: ts, updatedAt: ts, updatedBy: by});
        logger.info("adminBlachy: add", {id: ref.id, by});
        res.status(200).json({ok: true, blacha: toPublic(ref.id, v.data)});
        return;
      }

      res.status(400).json({error: "Nieznana akcja"});
    } catch (err: any) {
      logger.error("adminBlachy failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
