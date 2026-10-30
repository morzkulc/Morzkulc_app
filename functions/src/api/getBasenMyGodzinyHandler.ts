import type {Request, Response} from "express";
import {getBasenGodzinyRecords, computeBasenGodzinyBalance} from "../modules/basen/basen_godziny_service";
import {getBasenVars} from "../modules/basen/basen_service";
import {getKarnetEligibility, listUserOrders, MAX_SINGLE_COUNT} from "../modules/basen/basen_orders";
import {getAppVars} from "../modules/setup/app_vars";

type Deps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: (req: Request, res: Response, next: () => void) => void;
  requireIdToken: (req: Request) => Promise<{error: string} | {decoded: any}>;
};

/**
 * GET /api/basen/godziny/my (authenticated)
 * Pełna historia własnych godzin basenowych — "wyciąg bankowy" (dodane, zużyte,
 * zwrócone, nagrody za instruktorowanie), posortowana od najnowszych. Do tego dane
 * kafelków „Kup": cennik, uprawnienie do karnetu (z powodami), konto klubowe i
 * własne zamówienia.
 */
export async function handleGetBasenMyGodziny(req: Request, res: Response, deps: Deps): Promise<void> {
  if (deps.sendPreflight(req, res)) return;
  if (!deps.requireAllowedHost(req, res)) return;
  deps.setCorsHeaders(req, res);

  deps.corsHandler(req, res, async () => {
    if (req.method !== "GET") {
      res.status(405).json({error: "Method not allowed"});
      return;
    }

    try {
      const tokenCheck = await deps.requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }

      const uid = tokenCheck.decoded.uid;
      const [records, userSnap, vars, appVars, orders] = await Promise.all([
        getBasenGodzinyRecords(deps.db, uid),
        deps.db.collection("users_active").doc(uid).get(),
        getBasenVars(deps.db),
        getAppVars(deps.db),
        listUserOrders(deps.db, uid),
      ]);
      const karnet = await getKarnetEligibility(deps.db, uid, userSnap.data() || {});
      const balance = computeBasenGodzinyBalance(records);

      const sorted = [...records].sort((a, b) => {
        const at = (a.createdAt as any)?.toMillis?.() ?? 0;
        const bt = (b.createdAt as any)?.toMillis?.() ?? 0;
        return bt - at;
      });

      const serialized = sorted.map((r) => ({
        id: r.id,
        type: r.type,
        amount: r.amount,
        reason: r.reason,
        sessionId: r.sessionId ?? null,
        slot: r.slot ?? null,
        createdAt: r.createdAt && typeof (r.createdAt as any).toDate === "function" ?
          (r.createdAt as any).toDate().toISOString() :
          null,
      }));

      res.status(200).json({
        ok: true,
        balance,
        records: serialized,
        shop: {
          pricing: {
            jednorazowe: vars.basen_cena_za_godzine,
            karnet5: vars.basen_cena_karnet_5,
            karnet10: vars.basen_cena_karnet_10,
          },
          maxSingleCount: MAX_SINGLE_COUNT,
          seasonEnd: vars.basen_koniec_sezonu,
          karnet: {member: karnet.member, eligible: karnet.eligible, reasons: karnet.reasons},
          account: appVars.clubAccount,
          bank: appVars.clubBank,
        },
        orders,
      });
    } catch (err) {
      const e = err as {message?: string};
      res.status(500).json({error: "Server error", message: e?.message || String(err)});
    }
  });
}
