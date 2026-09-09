/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */

import type {Request, Response} from "express";
import {logger} from "firebase-functions/v2";
import {normNullish} from "../modules/shared/text_utils";
import {resolveDateRange} from "../modules/shared/date_range_utils";
import {fullName, nickname, isRegistered} from "../modules/shared/user_display";

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

      // Tylko rekordy "earn" mają grantedAt (północ UTC dnia pracy), więc zapytanie po
      // grantedAt w zakresie zwraca same earny — bez indeksu złożonego.
      const fromDate = new Date(from + "T00:00:00.000Z");
      const toDate = new Date(to + "T23:59:59.999Z");

      const snap = await db
        .collection("godzinki_ledger")
        .where("grantedAt", ">=", fromDate)
        .where("grantedAt", "<=", toDate)
        .orderBy("grantedAt")
        .limit(20000)
        .get();

      // Bilans otwarcia dla ZAREJESTROWANYCH użytkowników się liczy (jak najbardziej).
      // „Tylko zarejestrowani" załatwia filtr isRegistered niżej — historyczne konta
      // spoza users_active (np. pule pod hist_*) i tak nie przejdą.
      const hoursByUid = new Map<string, number>();
      snap.forEach((doc) => {
        const r = doc.data() as any;
        if (normNullish(r.type) !== "earn") return;
        if (r.approved !== true) return;
        const ruid = normNullish(r.uid);
        if (!ruid) return;
        hoursByUid.set(ruid, (hoursByUid.get(ruid) || 0) + Number(r.amount || 0));
      });

      const uidList = Array.from(hoursByUid.keys());
      const nameByUid = new Map<string, string>();
      const nickByUid = new Map<string, string>();
      const emailByUid = new Map<string, string>();
      const registered = new Set<string>();
      if (uidList.length) {
        const refs = uidList.map((u) => db.collection("users_active").doc(u));
        const userDocs = await db.getAll(...refs);
        userDocs.forEach((d) => {
          // Tylko zarejestrowani (ukończona rejestracja) — odsiewamy puste konta SSO.
          if (d.exists && isRegistered(d.data())) {
            const u = d.data();
            registered.add(d.id);
            nameByUid.set(d.id, fullName(u));
            nickByUid.set(d.id, nickname(u));
            emailByUid.set(d.id, normNullish((u as any)?.email));
          }
        });
      }

      // Tylko użytkownicy zarejestrowani w aplikacji (mają dokument users_active).
      const rows = uidList
        .filter((u) => registered.has(u))
        .map((u) => ({
          userUid: u,
          userName: nameByUid.get(u) || "",
          userNick: nickByUid.get(u) || "",
          userEmail: emailByUid.get(u) || "",
          hours: Math.round((hoursByUid.get(u) || 0) * 100) / 100,
        }))
        .sort((a, b) => (b.hours - a.hours) || a.userName.localeCompare(b.userName, "pl"))
        .map((row, i) => ({rank: i + 1, ...row}));

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
