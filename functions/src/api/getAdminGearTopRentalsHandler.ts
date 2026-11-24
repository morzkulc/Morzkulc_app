/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */

import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import {daysOnWaterInclusive} from "../modules/calendar/calendar_utils";
import {normNullish} from "../modules/shared/text_utils";
import {resolveDateRange} from "../modules/shared/date_range_utils";
import {fullName, nickname, publicMemberName} from "../modules/shared/user_display";
import {CATEGORY_LABELS} from "../modules/equipment/shared/gear_catalog_service";
import {effectiveRoleKey} from "../modules/users/member_standing";
import {loadBasenKayakUsage} from "../modules/basen/basen_usage";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; name?: string}};

export type GetAdminGearTopRentalsDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
  adminRoleKeys: string[];
  /**
   * "members" (E4, 24.11.2026): ten sam ranking w module Sprzęt dla członków —
   * dostęp dla każdego poza sympatykiem/zawieszonym, osoby jako ksywa albo imię +
   * inicjał nazwiska, bez e-maili. Domyślnie "admin" (raport Zarządu/KR).
   */
  audience?: "admin" | "members";
};

type RentalEntry = {
  userUid: string;
  userName: string;
  userNick: string;
  userEmail: string;
  days: number;
  /** "basen" = suma terminów basenowych tej osoby na tej sztuce (1 termin = 1 dzień). */
  source?: "basen";
};

type ItemAgg = {
  category: string;
  categoryLabel: string;
  number: string;
  name: string;
  totalDays: number;
  rentalsCount: number;
  rentals: RentalEntry[];
};

export async function handleGetAdminGearTopRentals(req: Request, res: Response, deps: GetAdminGearTopRentalsDeps) {
  const {sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, requireIdToken, db, adminRoleKeys} = deps;
  const membersView = deps.audience === "members";

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
      const roleKey = effectiveRoleKey(userSnap.data());
      const allowed = membersView ? Boolean(roleKey) && roleKey !== "rola_sympatyk" : adminRoleKeys.includes(roleKey);
      if (!allowed) {
        res.status(403).json({error: "Forbidden"});
        return;
      }

      const range = normNullish((req.query.range as string) || "semester").toLowerCase();
      const rr = resolveDateRange(range, (req.query.from as string) || "", (req.query.to as string) || "", {
        defaultKey: "semester",
        monthMode: "calendarMonth",
      });
      if (!rr.ok) {
        res.status(400).json({error: rr.message});
        return;
      }
      const {from, to, key} = rr;

      // Nakładanie okresu rezerwacji [startDate, endDate] na [from, to]:
      //   endDate >= from (filtr Firestore, pojedyncze pole → indeks automatyczny)
      //   startDate <= to (filtr w pamięci)
      const snap = await db
        .collection("gear_reservations")
        .where("endDate", ">=", from)
        .orderBy("endDate")
        .limit(2000)
        .get();

      const byKey = new Map<string, ItemAgg>();
      const missingNameRefs = new Map<string, {category: string; number: string}>();
      const uids = new Set<string>();

      for (const doc of snap.docs) {
        const r = doc.data() as any;
        if (normNullish(r.status) !== "active") continue;
        const startDate = normNullish(r.startDate);
        const endDate = normNullish(r.endDate);
        if (!startDate || startDate > to) continue; // brak nakładania

        // Pozycje: nowy format items[]; legacy fallback z kayakIds[] (bez nazwy — dociągamy niżej).
        let items: Array<{category: string; number: string; name: string}> = [];
        if (Array.isArray(r.items) && r.items.length) {
          items = r.items.map((it: any) => ({
            category: normNullish(it.category).toLowerCase(),
            number: normNullish(it.itemNumber) || normNullish(it.number),
            name: normNullish(it.itemLabel),
          }));
        } else if (Array.isArray(r.kayakIds) && r.kayakIds.length) {
          items = r.kayakIds.map((kid: any) => ({category: "kayaks", number: normNullish(kid), name: ""}));
        }
        if (!items.length) continue;

        // Dni nakładania tej rezerwacji z wybranym oknem (nie cała długość rezerwacji).
        const overlapStart = startDate > from ? startDate : from;
        const overlapEnd = endDate < to ? endDate : to;
        const days = daysOnWaterInclusive(overlapStart, overlapEnd);
        if (days <= 0) continue;

        const userUid = normNullish(r.userUid);
        const userEmail = normNullish(r.userEmail);
        if (userUid) uids.add(userUid);

        for (const it of items) {
          if (!it.category || !it.number) continue;
          const itemKey = `${it.category}/${it.number}`;
          const rentalEntry: RentalEntry = {userUid, userName: "", userNick: "", userEmail, days};
          const existing = byKey.get(itemKey);
          if (existing) {
            existing.totalDays += days;
            existing.rentalsCount += 1;
            existing.rentals.push(rentalEntry);
            if (!existing.name && it.name) existing.name = it.name;
          } else {
            byKey.set(itemKey, {
              category: it.category,
              categoryLabel: CATEGORY_LABELS[it.category] || it.category || "Sprzęt",
              number: it.number,
              name: it.name,
              totalDays: days,
              rentalsCount: 1,
              rentals: [rentalEntry],
            });
            if (!it.name) missingNameRefs.set(itemKey, {category: it.category, number: it.number});
          }
        }
      }

      // Basen: każdy termin = 1 dzień użycia sztuki; terminy jednej osoby na tej samej
      // sztuce sumowane w jeden wpis "basen" (bez prywatnych — patrz basen_usage.ts).
      const basenUsage = await loadBasenKayakUsage(db, from, to);
      for (const u of basenUsage) {
        const itemKey = `kayaks/${u.number}`;
        if (u.uid) uids.add(u.uid);
        let agg = byKey.get(itemKey);
        if (!agg) {
          agg = {
            category: "kayaks",
            categoryLabel: CATEGORY_LABELS.kayaks,
            number: u.number,
            name: u.label,
            totalDays: 0,
            rentalsCount: 0,
            rentals: [],
          };
          byKey.set(itemKey, agg);
        }
        if (!agg.name && u.label) {
          agg.name = u.label;
          missingNameRefs.delete(itemKey);
        }
        agg.totalDays += 1;
        agg.rentalsCount += 1;
        const existingBasen = agg.rentals.find((r) => r.source === "basen" && r.userUid === u.uid);
        if (existingBasen) {
          existingBasen.days += 1;
        } else {
          agg.rentals.push({userUid: u.uid, userName: "", userNick: "", userEmail: "", days: 1, source: "basen"});
        }
      }

      // Dociągnij nazwy (marka+model) dla pozycji bez itemLabel — legacy kayakIds[] (doc id = number).
      if (missingNameRefs.size) {
        const kayakKeys = Array.from(missingNameRefs.entries()).filter(([, v]) => v.category === "kayaks");
        if (kayakKeys.length) {
          const refs = kayakKeys.map(([, v]) => db.collection("gear_kayaks").doc(v.number));
          const kayakDocs = await db.getAll(...refs);
          kayakDocs.forEach((d, i) => {
            if (!d.exists) return;
            const [itemKey] = kayakKeys[i];
            const kd = d.data() as any;
            const name = [normNullish(kd?.brand), normNullish(kd?.model)].filter(Boolean).join(" ");
            if (name) {
              const agg = byKey.get(itemKey);
              if (agg) agg.name = name;
            }
          });
        }
      }

      // Rozwiąż nazwy użytkowników jednym batchem (jak w innych raportach).
      const uidList = Array.from(uids);
      if (uidList.length) {
        const refs = uidList.map((u) => db.collection("users_active").doc(u));
        const userDocs = await db.getAll(...refs);
        const nameByUid = new Map<string, string>();
        const nickByUid = new Map<string, string>();
        userDocs.forEach((d) => {
          if (d.exists) {
            nameByUid.set(d.id, membersView ? publicMemberName(d.data()) : fullName(d.data()));
            if (!membersView) nickByUid.set(d.id, nickname(d.data()));
          }
        });
        for (const item of byKey.values()) {
          for (const rental of item.rentals) {
            rental.userName = nameByUid.get(rental.userUid) || "";
            rental.userNick = nickByUid.get(rental.userUid) || "";
            if (membersView) {
              rental.userEmail = "";
              rental.userUid = "";
            }
          }
        }
      }

      const rows = Array.from(byKey.values())
        .sort((a, b) => (b.totalDays - a.totalDays) || a.number.localeCompare(b.number, "pl"))
        .map((row, i) => ({
          rank: i + 1,
          ...row,
          rentals: row.rentals.sort((a, b) => b.days - a.days),
        }));

      res.status(200).json({
        ok: true,
        range: {key, from, to},
        count: rows.length,
        rows,
      });
    } catch (err: any) {
      logger.error("getAdminGearTopRentals failed", {message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
