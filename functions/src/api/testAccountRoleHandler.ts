import type {Request, Response} from "express";
import * as admin from "firebase-admin";
import {isTestAccount} from "../modules/setup/app_vars";

type Deps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: (req: Request, res: Response, next: () => void) => void;
  requireIdToken: (req: Request) => Promise<{error: string} | {decoded: any}>;
};

export const TEST_ROLE_KEYS = ["rola_sympatyk", "rola_kandydat", "rola_kursant", "rola_czlonek", "rola_zarzad", "rola_kr"];

/**
 * POST /api/test/role  Body: { roleKey }
 * Konto testowe (konta_testowe w Vars_MEMBERS) przełącza sobie rolę — zapis wprost w
 * users_active, bez arkusza członków i bez grup Workspace (te zadania pomijają konta
 * testowe). Uprawnienia liczy dalej istniejący kod z role_key.
 */
export async function handleTestAccountRole(req: Request, res: Response, deps: Deps): Promise<void> {
  if (deps.sendPreflight(req, res)) return;
  if (!deps.requireAllowedHost(req, res)) return;
  deps.setCorsHeaders(req, res);

  deps.corsHandler(req, res, async () => {
    try {
      if (req.method !== "POST") {
        res.status(405).json({error: "Method not allowed"});
        return;
      }

      const tokenCheck = await deps.requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }

      const uid = tokenCheck.decoded.uid;
      const email = String(tokenCheck.decoded.email || "").trim().toLowerCase();
      if (!(await isTestAccount(deps.db, email))) {
        res.status(403).json({error: "To nie jest konto testowe."});
        return;
      }

      const roleKey = String(req.body?.roleKey || "").trim();
      if (!TEST_ROLE_KEYS.includes(roleKey)) {
        res.status(400).json({error: "Nieznana rola."});
        return;
      }

      const ref = deps.db.collection("users_active").doc(uid);
      const snap = await ref.get();
      if (!snap.exists) {
        res.status(403).json({error: "User not found"});
        return;
      }

      await ref.update({
        role_key: roleKey,
        status_key: "status_aktywny",
        testAccount: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      res.status(200).json({ok: true, roleKey});
    } catch (err) {
      const e = err as {message?: string};
      res.status(500).json({error: "Server error", message: e?.message || String(err)});
    }
  });
}
