import type {Request, Response} from "express";
import {ClientError, getBasenVars, resolveBasenAdminGrant} from "../modules/basen/basen_service";
import {approveOrder, cancelOwnOrder, createOrder, rejectOrder} from "../modules/basen/basen_orders";
import {isUserStatusBlocked} from "../modules/users/userStatusCheck";
import {fullName} from "../modules/shared/user_display";

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
 * POST /api/basen/order (authenticated)
 * Body: { action: "create", product, count? } — zamówienie godzin basenowych (każdy zalogowany;
 *         karnet tylko członek z opłaconymi składkami i dodatnim saldem godzinek)
 *       { action: "cancel", orderId } — anulowanie własnego niezatwierdzonego zamówienia
 *       { action: "approve", orderId } — potwierdzenie wpłaty (zarząd/KR/opiekun basenu)
 *       { action: "reject", orderId, reason } — odrzucenie z powodem (zarząd/KR/opiekun basenu)
 */
export async function handleBasenOrder(req: Request, res: Response, deps: Deps): Promise<void> {
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
      const userSnap = await deps.db.collection("users_active").doc(uid).get();
      if (!userSnap.exists) {
        res.status(403).json({error: "User not found"});
        return;
      }
      const userData = userSnap.data() as any;
      if (await isUserStatusBlocked(deps.db, String(userData?.status_key || ""))) {
        res.status(403).json({ok: false, code: "forbidden", error: "Konto zawieszone."});
        return;
      }

      const body = req.body || {};
      const action = String(body.action || "");
      const orderId = String(body.orderId || "").trim();

      if (action === "create") {
        const order = await createOrder(deps.db, {
          uid,
          userData,
          userName: fullName(userData) || String(userData?.email || uid),
          product: String(body.product || ""),
          count: body.count,
          pricing: await getBasenVars(deps.db),
        });
        res.status(200).json({ok: true, order: {id: order.id, label: order.label, amountPln: order.amountPln, transferTitle: order.transferTitle}});
        return;
      }

      if (action === "cancel") {
        if (!orderId) throw new ClientError("Brakuje orderId.");
        await cancelOwnOrder(deps.db, {uid, orderId});
        res.status(200).json({ok: true});
        return;
      }

      if (action === "approve" || action === "reject") {
        const isStaff = deps.adminRoleKeys.includes(String(userData?.role_key || "")) ||
          await resolveBasenAdminGrant(deps.db, String(userData?.email || ""));
        if (!isStaff) {
          res.status(403).json({error: "Brak uprawnień. Wymagana rola: zarząd/KR lub opiekun basenowy."});
          return;
        }
        if (!orderId) throw new ClientError("Brakuje orderId.");
        if (action === "approve") {
          await approveOrder(deps.db, {orderId, performedBy: uid});
        } else {
          await rejectOrder(deps.db, {orderId, performedBy: uid, reason: String(body.reason || "")});
        }
        res.status(200).json({ok: true});
        return;
      }

      res.status(400).json({error: "Nieznana akcja."});
    } catch (err) {
      const e = err as {message?: string};
      res.status(err instanceof ClientError ? 400 : 500).json({error: e?.message || String(err)});
    }
  });
}
