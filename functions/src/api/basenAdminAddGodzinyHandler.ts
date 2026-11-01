import type {Request, Response} from "express";
import {resolveBasenAdminGrant, getBasenVars} from "../modules/basen/basen_service";
import {adminAddBasenGodziny, addManualExtraBasenGodziny, getBasenGodzinyRecords, computeBasenGodzinyBalance} from "../modules/basen/basen_godziny_service";
import {BasenProduct} from "../modules/basen/basen_finance";
import {getKarnetEligibility, adminAddKarnet} from "../modules/basen/basen_orders";

const PRODUCTS: BasenProduct[] = ["jednorazowe", "karnet5", "karnet10"];

const MAX_MANUAL_EXTRA = 100;

type Deps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: (req: Request, res: Response, next: () => void) => void;
  requireIdToken: (req: Request) => Promise<{error: string} | {decoded: any}>;
  adminRoleKeys: string[];
};

/**
 * POST /api/basen/admin/godziny/add
 * Admin dopisuje wejścia po potwierdzeniu przelewu (regulamin basenu § 3).
 * Body: { userUid, product: "jednorazowe"|"karnet5"|"karnet10", count?: number (jednorazowe), reason? }
 * Karnet: członek z opłaconymi składkami i saldem godzinek wypracowanych ≥ koszt karnetu;
 * godzinki za karnet zdejmowane razem z dopisaniem (basen_orders.ts).
 *
 * POST /api/basen/admin/godziny/extra (ta sama funkcja, rozpoznawana po ścieżce)
 * Body: { userUid, amount: liczba całkowita 1–100, note? } — ekstra godziny basenowe bez wpłaty.
 */
export async function handleBasenAdminAddGodziny(req: Request, res: Response, deps: Deps): Promise<void> {
  if (deps.sendPreflight(req, res)) return;
  if (!deps.requireAllowedHost(req, res)) return;
  deps.setCorsHeaders(req, res);

  deps.corsHandler(req, res, async () => {
    if (req.method !== "POST") {
      res.status(405).json({error: "Method not allowed"});
      return;
    }

    try {
      const tokenCheck = await deps.requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }

      const adminUid = tokenCheck.decoded.uid;
      const adminSnap = await deps.db.collection("users_active").doc(adminUid).get();
      if (!adminSnap.exists) {
        res.status(403).json({error: "User not found"});
        return;
      }

      const adminData = adminSnap.data() as any;
      const adminRoleKey = String(adminData?.role_key || "");
      const adminEmail = String(adminData?.email || "");
      if (!deps.adminRoleKeys.includes(adminRoleKey) && !(await resolveBasenAdminGrant(deps.db, adminEmail))) {
        res.status(403).json({error: "Brak uprawnień. Wymagana rola: zarząd/KR lub opiekun basenowy."});
        return;
      }

      const body = req.body || {};
      const targetUid = String(body.userUid || "").trim();

      // POST /api/basen/admin/godziny/extra — ekstra godziny basenowe (0 zł), bez produktu.
      if (/\/godziny\/extra\/?$/.test(String(req.path || ""))) {
        const amount = Number(body.amount);
        const note = String(body.note || "").trim().slice(0, 200);
        if (!targetUid) {
          res.status(400).json({error: "Brakuje userUid."});
          return;
        }
        if (!Number.isInteger(amount) || amount <= 0 || amount > MAX_MANUAL_EXTRA) {
          res.status(400).json({error: `Liczba godzin basenowych musi być liczbą całkowitą od 1 do ${MAX_MANUAL_EXTRA}.`});
          return;
        }
        const target = await deps.db.collection("users_active").doc(targetUid).get();
        if (!target.exists) {
          res.status(400).json({error: "Użytkownik nie istnieje."});
          return;
        }
        const recordId = await addManualExtraBasenGodziny(deps.db, {uid: targetUid, amount, note, performedBy: adminUid});
        const newBalance = computeBasenGodzinyBalance(await getBasenGodzinyRecords(deps.db, targetUid));
        res.status(200).json({ok: true, recordId, newBalance});
        return;
      }

      const product = String(body.product || "") as BasenProduct;
      const count = Number(body.count || 0);
      const reason = String(body.reason || "").trim().slice(0, 200);

      if (!targetUid) {
        res.status(400).json({error: "Brakuje userUid."});
        return;
      }
      if (!PRODUCTS.includes(product)) {
        res.status(400).json({error: "Wybierz produkt: godziny basenowe pojedyncze, karnet 5 albo karnet 10."});
        return;
      }
      if (product === "jednorazowe" && (!Number.isInteger(count) || count <= 0)) {
        res.status(400).json({error: "Liczba godzin basenowych musi być większa od 0."});
        return;
      }

      const targetSnap = await deps.db.collection("users_active").doc(targetUid).get();
      if (!targetSnap.exists) {
        res.status(400).json({error: "Użytkownik nie istnieje."});
        return;
      }

      const vars = await getBasenVars(deps.db);
      if (product !== "jednorazowe") {
        // Karnet = dofinansowanie klubu (składki + godzinki wypracowane ≥ koszt karnetu).
        const karnet = await getKarnetEligibility(deps.db, targetUid, targetSnap.data() || {});
        if (!karnet.byProduct[product]) {
          res.status(400).json({error: `Karnet niedostępny: ${karnet.reasons.join(" ")}`});
          return;
        }
      }

      const recordId = product !== "jednorazowe" ?
        await adminAddKarnet(deps.db, {uid: targetUid, product, reason, performedBy: adminUid, vars}) :
        await adminAddBasenGodziny(deps.db, {uid: targetUid, product, count, reason, performedBy: adminUid, pricing: vars});

      const records = await getBasenGodzinyRecords(deps.db, targetUid);
      const newBalance = computeBasenGodzinyBalance(records);

      res.status(200).json({ok: true, recordId, newBalance});
    } catch (err) {
      const e = err as {message?: string};
      res.status(400).json({error: e?.message || String(err)});
    }
  });
}
