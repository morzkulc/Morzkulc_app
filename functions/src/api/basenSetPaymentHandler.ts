import type {Request, Response} from "express";
import {resolveBasenAdminGrant, ClientError} from "../modules/basen/basen_service";
import {parsePaymentInput, setSessionsPayment} from "../modules/basen/basen_payments";

type Deps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: (req: Request, res: Response, next: () => void) => void;
  requireIdToken: (req: Request) => Promise<{error: string} | {decoded: any}>;
};

/**
 * POST /api/basen/sessions/payment (authenticated, TYLKO obsługa basenu — resolveBasenAdminGrant)
 * Body: {sessionIds: string[], status: "invoice" | "cash" | "none", date?: "YYYY-MM-DD" (dla cash)}
 * Rozliczenie odbytych terminów z basenem: faktura wystawiona / zapłacono gotówką / cofnij.
 */
export async function handleBasenSetPayment(req: Request, res: Response, deps: Deps): Promise<void> {
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
      const uid = tokenCheck.decoded.uid;
      const userSnap = await deps.db.collection("users_active").doc(uid).get();
      const email = String((userSnap.data() as any)?.email || "");
      if (!userSnap.exists || !(await resolveBasenAdminGrant(deps.db, email))) {
        res.status(403).json({error: "Rozliczenia z basenem oznacza tylko obsługa basenu."});
        return;
      }

      const input = parsePaymentInput(req.body || {});
      const result = await setSessionsPayment(deps.db, {...input, markedBy: uid});
      res.status(200).json({ok: true, ...result});
    } catch (err) {
      const e = err as {message?: string};
      res.status(err instanceof ClientError ? 400 : 500).json({error: e?.message || String(err)});
    }
  });
}
