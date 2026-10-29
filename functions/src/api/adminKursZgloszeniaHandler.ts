/* eslint-disable require-jsdoc */
import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import {computeListy, ZGLOSZENIA_COLLECTION, ZgloszenieStatus} from "../modules/kurs/kurs_zgloszenia";
import {loadKursSignupConfig, przelewInfo} from "../modules/kurs/kurs_signup_config";
import {norm} from "../modules/shared/text_utils";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string}};

export type AdminKursDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
  adminRoleKeys: string[];
};

async function authorizeAdmin(req: Request, res: Response, deps: AdminKursDeps, method: "GET" | "POST") {
  if (req.method !== method) {
    res.status(405).json({error: "Method not allowed"});
    return null;
  }
  const tokenCheck = await deps.requireIdToken(req);
  if ("error" in tokenCheck) {
    res.status(401).json({error: tokenCheck.error});
    return null;
  }
  const uid = tokenCheck.decoded.uid;
  const userSnap = await deps.db.collection("users_active").doc(uid).get();
  if (!deps.adminRoleKeys.includes(norm((userSnap.data() as any)?.role_key))) {
    res.status(403).json({error: "Forbidden"});
    return null;
  }
  return {uid, email: norm(tokenCheck.decoded.email) || uid};
}

const ms = (t: any): number | null => (t?.toMillis ? t.toMillis() : null);
const iso = (t: any): string | null => (t?.toDate ? t.toDate().toISOString() : null);

/**
 * GET /api/admin/kurs/zgloszenia — zgłoszenia bieżącej edycji (kurs_edycja) z pozycją
 * na liście głównej/rezerwowej (kolejność wpłat zadatku, kurs_limit_miejsc).
 * Zawiera dane wrażliwe (PESEL, zdrowie) — tylko zarząd/KR.
 */
export async function handleAdminKursZgloszenia(req: Request, res: Response, deps: AdminKursDeps) {
  const {sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, db} = deps;
  if (sendPreflight(req, res)) return;
  if (!requireAllowedHost(req, res)) return;
  setCorsHeaders(req, res);

  corsHandler(req, res, async () => {
    try {
      const auth = await authorizeAdmin(req, res, deps, "GET");
      if (!auth) return;
      const cfg = await loadKursSignupConfig(db);
      const edycja = String(cfg.kurs.edycja || "");
      const snap = await db.collection(ZGLOSZENIA_COLLECTION).where("edycja", "==", edycja).get();
      const docs = snap.docs.map((d) => ({id: d.id, ...(d.data() as any)}));
      const limit = typeof cfg.kurs.limitMiejsc === "number" ? cfg.kurs.limitMiejsc : null;
      const listy = computeListy(docs.map((z) => ({
        id: z.id,
        status: z.status as ZgloszenieStatus,
        createdAtMs: ms(z.createdAt) ?? 0,
        zadatekAtMs: ms(z.zadatekAt),
      })), limit);

      const items = docs.map((z) => ({
        id: z.id,
        email: z.email,
        status: z.status,
        demo: z.demo === true,
        form: z.form,
        createdAt: iso(z.createdAt),
        zadatekAt: iso(z.zadatekAt),
        oplaconyAt: iso(z.oplaconyAt),
        rezygnacjaAt: iso(z.rezygnacjaAt),
        promotedAt: iso(z.promotedAt),
        removedAt: iso(z.removedAt),
        memberId: z.memberId ?? null,
        przelew: przelewInfo(cfg, z),
        ...(listy.get(z.id) || {pozycja: null, lista: null}),
      })).sort((a, b) => (a.pozycja ?? 1e9) - (b.pozycja ?? 1e9) || String(a.createdAt).localeCompare(String(b.createdAt)));

      const zajete = docs.filter((z) => z.status === "zadatek" || z.status === "oplacony").length;
      res.status(200).json({ok: true, edycja, limit, zajete, items});
    } catch (err: any) {
      logger.error("adminKursZgloszenia failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}

const TRANSITIONS: Record<string, {from: ZgloszenieStatus[]; to: ZgloszenieStatus; at: string; task?: string}> = {
  zadatek: {from: ["nowe"], to: "zadatek", at: "zadatekAt", task: "kurs.promoteToMembers"},
  oplacony: {from: ["nowe", "zadatek"], to: "oplacony", at: "oplaconyAt", task: "kurs.markPaid"},
  rezygnacja: {from: ["nowe", "zadatek", "oplacony"], to: "rezygnacja", at: "rezygnacjaAt", task: "kurs.removeKursant"},
};

/**
 * POST /api/admin/kurs/zgloszenie {id, action: "zadatek"|"oplacony"|"rezygnacja"}
 * Zmienia status i zleca task: zadatek → kursant w arkuszu członków (dostęp do
 * aplikacji), oplacony → pełna kwota w arkuszu, rezygnacja → sprzątanie.
 */
export async function handleAdminKursZgloszenieAction(req: Request, res: Response, deps: AdminKursDeps) {
  const {sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, db} = deps;
  if (sendPreflight(req, res)) return;
  if (!requireAllowedHost(req, res)) return;
  setCorsHeaders(req, res);

  corsHandler(req, res, async () => {
    try {
      const auth = await authorizeAdmin(req, res, deps, "POST");
      if (!auth) return;
      const id = norm((req.body as any)?.id);
      const action = norm((req.body as any)?.action);
      const t = TRANSITIONS[action];
      if (!id || !t) {
        res.status(400).json({ok: false, code: "bad_request", message: "Wymagane: id, action (zadatek|oplacony|rezygnacja)"});
        return;
      }
      const ref = db.collection(ZGLOSZENIA_COLLECTION).doc(id);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return {code: "not_found"};
        const z = snap.data() as any;
        if (!t.from.includes(z.status)) return {code: "bad_status", status: z.status};
        const patch: Record<string, any> = {
          status: t.to,
          [t.at]: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          history: admin.firestore.FieldValue.arrayUnion({action, by: auth.email, at: new Date().toISOString()}),
        };
        // Pełna wpłata bez osobnego zadatku liczy się też jako zadatek (kolejność listy).
        if (action === "oplacony" && !z.zadatekAt) patch.zadatekAt = admin.firestore.FieldValue.serverTimestamp();
        tx.update(ref, patch);
        // Rezygnacja przed wpłatą: osoby nie ma w arkuszu ani w aplikacji — nic do sprzątania.
        const needsTask = action !== "rezygnacja" || z.status !== "nowe" || Boolean(z.memberId);
        return {code: "ok", needsTask};
      });

      if (result.code === "not_found") {
        res.status(404).json({ok: false, code: "not_found", message: "Zgłoszenie nie istnieje"});
        return;
      }
      if (result.code === "bad_status") {
        res.status(409).json({ok: false, code: "bad_status", message: `Nie można zmienić statusu „${(result as any).status}” akcją „${action}”`});
        return;
      }
      if ((result as any).needsTask && t.task) {
        const jobRef = db.collection("service_jobs").doc();
        await jobRef.set({
          id: jobRef.id, taskId: t.task, payload: {id}, status: "queued", attempts: 0,
          createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      logger.info("adminKursZgloszenieAction", {id, action, by: auth.email});
      res.status(200).json({ok: true});
    } catch (err: any) {
      logger.error("adminKursZgloszenieAction failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
