/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */

import type {Request, Response} from "express";
import {logger} from "firebase-functions/v2";
import {computeBalance, GodzinkiRecord} from "../modules/hours/godzinki_service";
import {normNullish} from "../modules/shared/text_utils";
import {todayWarsawIso} from "../modules/shared/date_range_utils";
import {fullName, nickname, isRegistered} from "../modules/shared/user_display";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; name?: string}};

export type GetAdminMemberDuesDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
  adminRoleKeys: string[];
};

// Populacja raportu = pełni członkowie (głosujący). Kandydaci/sympatycy/kursanci poza.
const MEMBER_ROLE_KEYS = ["rola_czlonek", "rola_zarzad", "rola_kr"];

/** Parsuje „składki opłacone do" (YYYY-MM-DD | DD-MM-YYYY | DD.MM.YYYY) → Date (UTC) lub null. */
function parseContrib(raw: any): Date | null {
  const s = normNullish(raw);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = s.match(/^(\d{2})[-.](\d{2})[-.](\d{4})$/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return null;
}

export async function handleGetAdminMemberDues(req: Request, res: Response, deps: GetAdminMemberDuesDeps) {
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

      // Pełni członkowie (zarejestrowani = w users_active) + cały ledger do salda.
      const [membersSnap, ledgerSnap] = await Promise.all([
        db.collection("users_active").where("role_key", "in", MEMBER_ROLE_KEYS).get(),
        db.collection("godzinki_ledger").get(),
      ]);

      // Saldo godzinek per uid ze WSZYSTKICH rekordów (włącznie z bilansem otwarcia) —
      // to realne saldo, jakie user widzi w profilu; liczy się do uprawnienia do głosowania.
      // (Bilans otwarcia wykluczamy tylko w raporcie aktywności, nie tutaj.)
      const recsByUid = new Map<string, GodzinkiRecord[]>();
      ledgerSnap.forEach((doc) => {
        const r = doc.data() as any;
        const ruid = normNullish(r.uid);
        if (!ruid) return;
        const arr = recsByUid.get(ruid);
        if (arr) arr.push(r as GodzinkiRecord);
        else recsByUid.set(ruid, [r as GodzinkiRecord]);
      });

      const now = new Date();
      const todayMidnight = new Date(todayWarsawIso() + "T00:00:00.000Z");

      type Row = {
        userUid: string;
        userName: string;
        userNick: string;
        userEmail: string;
        roleKey: string;
        contributionsPaidUntil: string;
        paid: boolean;
        balance: number;
        votingEligible: boolean;
      };

      // Tylko zarejestrowani (ukończona rejestracja) — odsiewamy puste konta SSO.
      const memberDocs = membersSnap.docs.filter((d) => isRegistered(d.data()));

      const rows: Row[] = memberDocs.map((d) => {
        const u = d.data() as any;
        const contribRaw = normNullish(u?.contributionsPaidUntil ?? u?.admin?.contributions);
        const contribDate = parseContrib(contribRaw);
        const paid = Boolean(contribDate && contribDate.getTime() >= todayMidnight.getTime());
        const balance = computeBalance(recsByUid.get(d.id) || [], now);
        return {
          userUid: d.id,
          userName: fullName(u),
          userNick: nickname(u),
          userEmail: normNullish(u?.email),
          roleKey: normNullish(u?.role_key),
          contributionsPaidUntil: contribRaw,
          paid,
          balance,
          votingEligible: paid && balance > 0,
        };
      });

      rows.sort((a, b) => a.userName.localeCompare(b.userName, "pl"));

      const summary = {
        total: rows.length,
        overdue: rows.filter((r) => !r.paid).length,
        paid: rows.filter((r) => r.paid).length,
        voting: rows.filter((r) => r.votingEligible).length,
      };

      res.status(200).json({ok: true, summary, count: rows.length, rows});
    } catch (err: any) {
      logger.error("getAdminMemberDues failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
