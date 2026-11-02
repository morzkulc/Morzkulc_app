import type {Request, Response} from "express";
import * as admin from "firebase-admin";
import * as logger from "firebase-functions/logger";
import {getAppVars} from "../modules/setup/app_vars";
import {todayWarsawIso} from "../modules/shared/date_range_utils";
import {normNullish} from "../modules/shared/text_utils";
import {fullName, isRegistered, nickname} from "../modules/shared/user_display";
import {MEMBER_ROLE_KEYS} from "../modules/users/member_standing";
import {
  DUES_ORDERS, DuesClientError, DuesOrder, approveDuesOrder, computeDuesStatus, isTreasurer, paidUntilAfterPayment, rejectDuesOrder,
} from "../modules/dues/dues_service";

type Deps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: (req: Request, res: Response, next: () => void) => void;
  requireIdToken: (req: Request) => Promise<{error: string} | {decoded: any}>;
  adminRoleKeys: string[];
};

const RECENT_DAYS = 60;

function iso(ts: any): string | null {
  return ts?.toDate ? ts.toDate().toISOString() : (ts instanceof Date ? ts.toISOString() : null);
}

/**
 * GET  /api/admin/dues — panel „Składki" (Zarząd/KR podgląd): zgłoszenia, ostatnio zatwierdzone,
 *      lista zaległości (do limitu) i osobno zaległości powyżej limitu semestrów.
 * POST /api/admin/dues — TYLKO skarbnik (lub admin@): {action: "approve"|"reject", orderId, reason?}
 *      albo {action: "remind", uids: [...]} — przypomnienie mailem.
 */
export async function handleAdminDues(req: Request, res: Response, deps: Deps): Promise<void> {
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
      const userData = (await deps.db.collection("users_active").doc(uid).get()).data() as any;
      const email = normNullish(userData?.email || tokenCheck.decoded.email).toLowerCase();
      const treasurer = await isTreasurer(deps.db, email);
      if (!treasurer && !deps.adminRoleKeys.includes(String(userData?.role_key || ""))) {
        res.status(403).json({error: "Forbidden"});
        return;
      }

      if (req.method === "GET") {
        const vars = await getAppVars(deps.db);
        const today = todayWarsawIso();
        const [ordersSnap, usersSnap] = await Promise.all([
          deps.db.collection(DUES_ORDERS).get(),
          deps.db.collection("users_active").where("role_key", "in", MEMBER_ROLE_KEYS).get(),
        ]);
        const contribByUid = new Map(usersSnap.docs.map((d) => [d.id, (d.data() as any)?.admin?.contributions]));
        const recentCutoff = Date.now() - RECENT_DAYS * 86400000;
        const orders = ordersSnap.docs.map((d) => d.data() as DuesOrder & Record<string, any>);
        const toRow = (o: DuesOrder & Record<string, any>) => ({
          id: o.id, uid: o.uid, memberId: o.memberId, userName: o.userName, kind: o.kind, semesters: o.semesters,
          amountPln: o.amountPln, transferTitle: o.transferTitle, status: o.status, createdAt: iso(o.createdAt),
          decidedAt: iso(o.decidedAt), rejectReason: o.rejectReason || "",
          writeBack: o.writeBack || null,
          // Podgląd daty po potwierdzeniu (liczona ponownie przy zatwierdzeniu).
          previewPaidUntil: o.status === "pending" && vars.semesterEnds.length ?
            paidUntilAfterPayment(contribByUid.get(o.uid), o.semesters, today, vars.semesterEnds) : "",
        });
        const pending = orders.filter((o) => o.status === "pending").map(toRow)
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
        const recent = orders
          .filter((o) => o.status === "approved" || o.status === "rejected")
          .filter((o) => o.writeBack?.status !== "done" || (o.decidedAt?.toMillis?.() ?? 0) >= recentCutoff)
          .map(toRow)
          .sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)));

        const testAccounts = new Set(vars.testAccounts);
        const overdue = usersSnap.docs
          .map((d) => ({id: d.id, u: d.data() as any}))
          .filter(({u}) => u?.status_key === "status_aktywny" && isRegistered(u) && !testAccounts.has(normNullish(u?.email).toLowerCase()))
          .map(({id, u}) => {
            const st = computeDuesStatus(u, vars, today);
            return {
              uid: id, memberId: u?.memberId ?? null, userName: fullName(u), userNick: nickname(u), email: normNullish(u?.email),
              roleKey: u?.role_key, kind: st.kind, paidUntil: st.paidUntil, overdue: st.overdue, blocked: st.blocked,
              reminderSentAt: iso(u?.service?.duesReminderSentAt),
            };
          })
          .filter((r) => r.overdue === null || r.overdue > 0)
          // „Brak wpłat" (null) na górze — najpilniejsze; dalej od najmniejszej zaległości do największej.
          .sort((a, b) => (a.overdue ?? -1) - (b.overdue ?? -1) || a.userName.localeCompare(b.userName, "pl"));

        res.status(200).json({
          ok: true, isTreasurer: treasurer, feePln: vars.duesFeePln, maxOverdue: vars.duesMaxOverdueSemesters,
          pending, recent,
          overdue: overdue.filter((r) => !r.blocked),
          overdueBlocked: overdue.filter((r) => r.blocked),
        });
        return;
      }

      if (req.method !== "POST") {
        res.status(405).json({error: "Method not allowed"});
        return;
      }
      if (!treasurer) {
        res.status(403).json({error: "Składki obsługuje skarbnik."});
        return;
      }
      const body = req.body || {};
      const action = String(body.action || "");
      const orderId = String(body.orderId || "").trim();
      if (action === "approve") {
        if (!orderId) throw new DuesClientError("Brakuje orderId.");
        const r = await approveDuesOrder(deps.db, {orderId, performedBy: uid});
        res.status(200).json({ok: true, ...r});
        return;
      }
      if (action === "reject") {
        if (!orderId) throw new DuesClientError("Brakuje orderId.");
        await rejectDuesOrder(deps.db, {orderId, performedBy: uid, reason: String(body.reason || "")});
        res.status(200).json({ok: true});
        return;
      }
      if (action === "remind") {
        const uids = Array.isArray(body.uids) ? Array.from(new Set(body.uids.map((x: any) => String(x)).filter(Boolean))) as string[] : [];
        if (!uids.length) throw new DuesClientError("Zaznacz osoby do przypomnienia.");
        const now = admin.firestore.FieldValue.serverTimestamp();
        await Promise.all(uids.map((u) => {
          const jobRef = deps.db.collection("service_jobs").doc();
          return jobRef.set({id: jobRef.id, taskId: "dues.sendReminder", payload: {uid: u, requestedBy: email}, status: "queued", attempts: 0, createdAt: now, updatedAt: now});
        }));
        res.status(200).json({ok: true, queued: uids.length});
        return;
      }
      res.status(400).json({error: "Nieznana akcja."});
    } catch (err: any) {
      if (err instanceof DuesClientError) {
        res.status(400).json({error: err.message});
        return;
      }
      logger.error("adminDues failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
