/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */

import type {Request, Response} from "express";
import {logger} from "firebase-functions/v2";
import {normNullish} from "../modules/shared/text_utils";
import {resolveDateRange} from "../modules/shared/date_range_utils";
import {fullName, nickname} from "../modules/shared/user_display";
import {CATEGORY_LABELS} from "../modules/equipment/shared/gear_catalog_service";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; name?: string}};

export type GetAdminGearRentalsDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
  adminRoleKeys: string[];
};

export async function handleGetAdminGearRentals(req: Request, res: Response, deps: GetAdminGearRentalsDeps) {
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

      const range = normNullish((req.query.range as string) || "current").toLowerCase();
      const rr = resolveDateRange(range, (req.query.from as string) || "", (req.query.to as string) || "", {
        supportsCurrent: true,
        defaultKey: "current",
        monthMode: "days30",
      });
      if (!rr.ok) {
        res.status(400).json({error: rr.message});
        return;
      }
      const {from, to, key} = rr;

      // Nakładanie na [from, to] liczone po OKNIE BLOKADY [blockStartIso, blockEndIso],
      // nie po [startDate, endDate] — blockStartIso uwzględnia offset (wcześniejszy
      // możliwy odbiór), więc sprzęt jest już realnie niedostępny zanim nadejdzie
      // "oficjalna" startDate. To te same pola, których reszta kodu (konflikty,
      // limity per kategoria) używa do wykrywania "czy sprzęt jest zajęty".
      //   blockEndIso >= from (filtr Firestore, pojedyncze pole → indeks automatyczny)
      //   blockStartIso <= to (filtr w pamięci)
      const snap = await db
        .collection("gear_reservations")
        .where("blockEndIso", ">=", from)
        .orderBy("blockEndIso")
        .limit(1000)
        .get();

      type Row = {
        id: string;
        userUid: string;
        userName: string;
        userNick: string;
        userEmail: string;
        startDate: string;
        endDate: string;
        costHours: number;
        items: Array<{category: string; categoryLabel: string; number: string; label: string}>;
      };

      const rows: Row[] = [];
      const uids = new Set<string>();

      for (const doc of snap.docs) {
        const r = doc.data() as any;
        if (normNullish(r.status) !== "active") continue;
        const blockStartIso = normNullish(r.blockStartIso);
        if (!blockStartIso || blockStartIso > to) continue; // brak nakładania
        const startDate = normNullish(r.startDate);

        // Pozycje: nowy format items[]; legacy fallback z kayakIds[].
        let items: Row["items"] = [];
        if (Array.isArray(r.items) && r.items.length) {
          items = r.items.map((it: any) => {
            const cat = normNullish(it.category).toLowerCase();
            return {
              category: cat,
              categoryLabel: CATEGORY_LABELS[cat] || normNullish(it.category) || "Sprzęt",
              number: normNullish(it.itemNumber) || normNullish(it.number),
              label: normNullish(it.label),
            };
          });
        } else if (Array.isArray(r.kayakIds) && r.kayakIds.length) {
          items = r.kayakIds.map((kid: any) => ({
            category: "kayaks",
            categoryLabel: CATEGORY_LABELS.kayaks,
            number: normNullish(kid),
            label: "",
          }));
        }

        const userUid = normNullish(r.userUid);
        if (userUid) uids.add(userUid);

        rows.push({
          id: normNullish(r.id) || doc.id,
          userUid,
          userName: "",
          userNick: "",
          userEmail: normNullish(r.userEmail),
          startDate,
          endDate: normNullish(r.endDate),
          costHours: Number(r.costHours || 0),
          items,
        });
      }

      // Rozwiąż nazwy użytkowników jednym batchem.
      const uidList = Array.from(uids);
      if (uidList.length) {
        const refs = uidList.map((u) => db.collection("users_active").doc(u));
        const userDocs = await db.getAll(...refs);
        const nameByUid = new Map<string, string>();
        const nickByUid = new Map<string, string>();
        userDocs.forEach((d) => {
          if (d.exists) {
            nameByUid.set(d.id, fullName(d.data()));
            nickByUid.set(d.id, nickname(d.data()));
          }
        });
        for (const row of rows) {
          row.userName = nameByUid.get(row.userUid) || "";
          row.userNick = nickByUid.get(row.userUid) || "";
        }
      }

      // Najnowsze wypożyczenia na górze.
      rows.sort((a, b) => (b.startDate.localeCompare(a.startDate)) || a.userName.localeCompare(b.userName, "pl"));

      res.status(200).json({
        ok: true,
        range: {key, from, to},
        count: rows.length,
        rows,
      });
    } catch (err: any) {
      logger.error("getAdminGearRentals failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
