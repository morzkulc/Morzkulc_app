/* eslint-disable require-jsdoc */
import type {Request, Response} from "express";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import {isPhoneValid, normalizePersonName, normalizePhone} from "../modules/users/profile_fields";
import {birthDateMessage, checkBirthDate} from "../modules/users/birth_date";
import {getAppVars, isTestAccount} from "../modules/setup/app_vars";
import {todayWarsawIso} from "../modules/shared/date_range_utils";

type Deps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: (req: Request, res: Response, next: () => void) => void;
  requireIdToken: (req: Request) => Promise<{error: string} | {decoded: any}>;
};

export const PROFILE_SHEET_TASK_ID = "members.updateProfileInSheet";

function view(u: any) {
  const p = u?.profile || {};
  return {firstName: String(p.firstName || ""), lastName: String(p.lastName || ""), phone: String(p.phone || ""),
    dateOfBirth: String(p.dateOfBirth || "")};
}

/**
 * GET  /api/profile/data — własne imię, nazwisko, telefon, data urodzenia (+ ocena daty: birthDate).
 * POST /api/profile/data — {firstName, lastName, phone, dateOfBirth}: zapis w bazie + job members.updateProfileInSheet,
 *      który od razu wpisuje te trzy komórki do arkusza członków (arkusz jest źródłem tych pól —
 *      nocny users.syncFieldsFromSheet nadpisałby zmianę zrobioną tylko w bazie).
 */
export async function handleProfileData(req: Request, res: Response, deps: Deps): Promise<void> {
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
      const ref = deps.db.collection("users_active").doc(uid);
      const snap = await ref.get();
      if (!snap.exists) {
        res.status(403).json({error: "User not found"});
        return;
      }
      const u = snap.data() as any;

      const vars = await getAppVars(deps.db);
      const today = todayWarsawIso();
      const birthDate = (dob: string) => {
        const c = checkBirthDate(dob, today, vars.ageLimits);
        return {code: c.code, ok: c.ok, message: birthDateMessage(c.code, vars.ageLimits)};
      };

      if (req.method === "GET") {
        const v = view(u);
        res.status(200).json({ok: true, ...v, birthDate: v.dateOfBirth ? birthDate(v.dateOfBirth) : null});
        return;
      }
      if (req.method !== "POST") {
        res.status(405).json({error: "Method not allowed"});
        return;
      }

      const body = req.body || {};
      const firstName = normalizePersonName(body.firstName);
      const lastName = normalizePersonName(body.lastName);
      const phone = normalizePhone(body.phone);
      const dateOfBirth = String(body.dateOfBirth || "").trim();
      if (!firstName || !lastName || !phone || !dateOfBirth) {
        res.status(400).json({error: "Uzupełnij imię, nazwisko, telefon i datę urodzenia."});
        return;
      }
      const bd = birthDate(dateOfBirth);
      if (!bd.ok) {
        res.status(400).json({error: bd.message, code: "birth_date_" + bd.code});
        return;
      }
      if (!isPhoneValid(phone)) {
        res.status(400).json({error: "Telefon ma nieprawidłowy format (8–15 cyfr)."});
        return;
      }

      const before = view(u);
      if (before.firstName === firstName && before.lastName === lastName && before.phone === phone && before.dateOfBirth === dateOfBirth) {
        res.status(200).json({ok: true, changed: false, sheet: "unchanged", ...before, birthDate: bd});
        return;
      }

      const now = admin.firestore.FieldValue.serverTimestamp();
      // update() z kropkami = ścieżki pól (set() z kropką zapisałby dosłowny klucz).
      await ref.update({
        "profile.firstName": firstName,
        "profile.lastName": lastName,
        "profile.phone": phone,
        "profile.dateOfBirth": dateOfBirth,
        "profile.updatedAt": now,
        "updatedAt": now,
      });

      const skipSheet = !u?.memberId || await isTestAccount(deps.db, String(u?.email || ""));
      if (!skipSheet) {
        const jobRef = deps.db.collection("service_jobs").doc();
        await jobRef.set({id: jobRef.id, taskId: PROFILE_SHEET_TASK_ID, payload: {uid},
          status: "queued", attempts: 0, createdAt: now, updatedAt: now});
      }
      // 16–17 lat: mail do Zarządu (task deduplikuje po dacie urodzenia).
      if (bd.code === "minor" && dateOfBirth !== before.dateOfBirth) {
        const mRef = deps.db.collection("service_jobs").doc();
        await mRef.set({id: mRef.id, taskId: "users.notifyMinorMember", payload: {uid},
          status: "queued", attempts: 0, createdAt: now, updatedAt: now});
      }
      logger.info("profileData: updated", {uid, sheet: skipSheet ? "skipped" : "queued"});
      res.status(200).json({ok: true, changed: true, sheet: skipSheet ? "skipped" : "queued", firstName, lastName, phone, dateOfBirth, birthDate: bd});
    } catch (err: any) {
      logger.error("profileData failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
