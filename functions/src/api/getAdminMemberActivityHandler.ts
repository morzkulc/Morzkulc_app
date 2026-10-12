/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */

import type {Request, Response} from "express";
import {logger} from "firebase-functions/v2";
import {normNullish} from "../modules/shared/text_utils";
import {resolveDateRange} from "../modules/shared/date_range_utils";
import {computeMemberActivity} from "../modules/hours/member_activity";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; name?: string}};

export type GetAdminMemberActivityDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
  adminRoleKeys: string[];
};

export async function handleGetAdminMemberActivity(req: Request, res: Response, deps: GetAdminMemberActivityDeps) {
  const {sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, requireIdToken, db, adminRoleKeys} = deps;

  if (sendPreflight(req, res)) return;
  if (!requireAllowedHost(req, res)) return;
  setCorsHeaders(req, res);

  corsHandler(req, res, async () => {
    try {
      if (req.method !== "GET") {
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
      const roleKey = normNullish((userSnap.data() as any)?.role_key);
      if (!adminRoleKeys.includes(roleKey)) {
        res.status(403).json({error: "Forbidden"});
        return;
      }

      const range = normNullish((req.query.range as string) || "semester").toLowerCase();
      const rr = resolveDateRange(range, (req.query.from as string) || "", (req.query.to as string) || "", {
        defaultKey: "semester",
      });
      if (!rr.ok) {
        res.status(400).json({error: rr.message});
        return;
      }
      const {from, to, key} = rr;

      const rows = await computeMemberActivity(db, from, to);

      res.status(200).json({
        ok: true,
        range: {key, from, to},
        count: rows.length,
        rows,
      });
    } catch (err: any) {
      logger.error("getAdminMemberActivity failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
