/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */

import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import {compositeId, isSupportedBundleCategory} from "../modules/equipment/bundle/gear_bundle_service";
import {effectiveRoleKey} from "../modules/users/member_standing";
import {publicMemberName} from "../modules/shared/user_display";
import {todayWarsawIso, minusMonths} from "../modules/shared/date_range_utils";
import {loadBasenKayakHistory} from "../modules/basen/basen_usage";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; name?: string}};

export type GetKayakReservationsDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
};

function todayIsoUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function handleGetKayakReservations(
  req: Request,
  res: Response,
  deps: GetKayakReservationsDeps
) {
  const {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  } = deps;

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

      // "itemId" is the generic param; "kayakId" stays as an accepted alias so the
      // existing per-card "Więcej" caller (gear_module.js) keeps working unchanged.
      const itemId = String(req.query?.itemId || req.query?.kayakId || "").trim();
      if (!itemId) {
        res.status(400).json({error: "Missing itemId"});
        return;
      }

      const categoryRaw = String(req.query?.category || "kayaks").trim().toLowerCase();
      if (!isSupportedBundleCategory(categoryRaw)) {
        res.status(400).json({error: "Unsupported category"});
        return;
      }

      const excludeReservationId = String(req.query?.excludeReservationId || "").trim();

      // Tryb historii (decyzja 24.11.2026): tylko ZAKOŃCZONE wypożyczenia (endDate < dziś),
      // "year" = rok wstecz, "all" = cała historia; + terminy basenowe (kajaki).
      // Niedostępne dla sympatyka i zawieszonego (effectiveRoleKey → rola_sympatyk).
      const historyMode = String(req.query?.history || "").trim().toLowerCase();
      if (historyMode && historyMode !== "year" && historyMode !== "all") {
        res.status(400).json({error: "Invalid history mode"});
        return;
      }
      if (historyMode) {
        const userSnap = await db.collection("users_active").doc(tokenCheck.decoded.uid).get();
        const roleKey = effectiveRoleKey(userSnap.exists ? userSnap.data() : null);
        if (!roleKey || roleKey === "rola_sympatyk") {
          res.status(403).json({ok: false, code: "forbidden", message: "Historia wypożyczeń jest dostępna dla członków klubu."});
          return;
        }
      }

      const todayIso = todayIsoUTC();
      const cid = compositeId(categoryRaw, itemId);

      // New-format bundle docs always carry itemIds — a direct array-contains query.
      const itemIdsSnap = await db
        .collection("gear_reservations")
        .where("status", "==", "active")
        .where("itemIds", "array-contains", cid)
        .get();

      const docsById = new Map<string, any>();
      for (const d of itemIdsSnap.docs) docsById.set(d.id, d.data());

      // Legacy pre-bundle kayak docs only have kayakIds, never itemIds.
      if (categoryRaw === "kayaks") {
        const kayakIdsSnap = await db
          .collection("gear_reservations")
          .where("status", "==", "active")
          .where("kayakIds", "array-contains", itemId)
          .get();
        for (const d of kayakIdsSnap.docs) {
          if (!docsById.has(d.id)) docsById.set(d.id, d.data());
        }
      }

      if (historyMode) {
        await respondWithHistory(res, db, {category: categoryRaw, itemId, historyMode, docs: Array.from(docsById.values())});
        return;
      }

      const docs = Array.from(docsById.entries())
        .filter(([id, r]) => String(r?.blockEndIso || "") >= todayIso && id !== excludeReservationId)
        .map(([, r]) => r);

      // Batch-fetch user display names from users_active
      const uids = [...new Set(docs.map((r) => String(r?.userUid || "")).filter(Boolean))];

      const nameMap: Record<string, string> = {};
      if (uids.length) {
        const userSnaps = await db.getAll(...uids.map((uid) => db.collection("users_active").doc(uid)));
        for (const userSnap of userSnaps) {
          if (!userSnap.exists) continue;
          const data = userSnap.data() as any;
          const firstName = String(data?.profile?.firstName || "").trim();
          const lastName = String(data?.profile?.lastName || "").trim();
          const displayName = [firstName, lastName].filter(Boolean).join(" ");
          nameMap[userSnap.id] = displayName || String(data?.email || "");
        }
      }

      // Batch-fetch nazwy imprez dla rezerwacji "na imprezę klubową" — widoczność
      // dla WSZYSTKICH użytkowników przeglądających sprzęt objęła też nazwę imprezy
      // (feedback użytkownika 04.09.2026, wcześniej świadomie tylko kierownik bez nazwy).
      const eventIds = [...new Set(docs.map((r) => String(r?.eventId || "")).filter(Boolean))];
      const eventNameMap: Record<string, string> = {};
      if (eventIds.length) {
        const eventSnaps = await db.getAll(...eventIds.map((id) => db.collection("events").doc(id)));
        for (const eventSnap of eventSnaps) {
          if (!eventSnap.exists) continue;
          eventNameMap[eventSnap.id] = String((eventSnap.data() as any)?.name || "");
        }
      }

      const reservations = docs
        .sort((a, b) =>
          String(a?.startDate || "").localeCompare(String(b?.startDate || ""))
        )
        .map((r) => ({
          startDate: String(r?.startDate || ""),
          endDate: String(r?.endDate || ""),
          blockStartIso: String(r?.blockStartIso || ""),
          blockEndIso: String(r?.blockEndIso || ""),
          userDisplayName:
            nameMap[String(r?.userUid || "")] || String(r?.userEmail || ""),
          // Rezerwacja "na imprezę klubową" — front pokazuje "Impreza klubowa: {nazwa}"
          // zamiast nazwiska.
          isClubEvent: Boolean(r?.eventId),
          eventName: r?.eventId ? (eventNameMap[String(r.eventId)] || "") : "",
        }));

      res.status(200).json({ok: true, category: categoryRaw, itemId, kayakId: itemId, reservations});
    } catch (err: any) {
      logger.error("getKayakReservations failed", {
        message: err?.message,
        stack: err?.stack,
      });
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}

export type ItemHistoryEntry = {
  startDate: string;
  endDate: string;
  userUid: string;
  source: "reservation" | "basen";
  isClubEvent: boolean;
  eventId: string;
};

/**
 * Zakończone wypożyczenia sztuki z zakresu: endDate < todayIso i (fromIso pusty
 * albo endDate >= fromIso). Najnowsze na górze. Czysta funkcja — eksport dla testów.
 */
export function selectEndedReservations(docs: any[], todayIso: string, fromIso: string): ItemHistoryEntry[] {
  return docs
    .map((r) => ({
      startDate: String(r?.startDate || ""),
      endDate: String(r?.endDate || ""),
      userUid: String(r?.userUid || ""),
      source: "reservation" as const,
      isClubEvent: Boolean(r?.eventId),
      eventId: String(r?.eventId || ""),
    }))
    .filter((r) => r.startDate && r.endDate && r.endDate < todayIso && (!fromIso || r.endDate >= fromIso));
}

async function respondWithHistory(
  res: Response,
  db: FirebaseFirestore.Firestore,
  args: {category: string; itemId: string; historyMode: string; docs: any[]}
) {
  const todayIso = todayWarsawIso();
  const fromIso = args.historyMode === "year" ? minusMonths(todayIso, 12) : "";

  const entries = selectEndedReservations(args.docs, todayIso, fromIso);
  if (args.category === "kayaks") {
    const basen = await loadBasenKayakHistory(db, args.itemId, fromIso, todayIso);
    for (const u of basen) {
      entries.push({startDate: u.date, endDate: u.date, userUid: u.uid, source: "basen", isClubEvent: false, eventId: ""});
    }
  }
  entries.sort((a, b) => b.endDate.localeCompare(a.endDate) || b.startDate.localeCompare(a.startDate));

  const uids = [...new Set(entries.map((e) => e.userUid).filter(Boolean))];
  const nameByUid = new Map<string, string>();
  if (uids.length) {
    const snaps = await db.getAll(...uids.map((uid) => db.collection("users_active").doc(uid)));
    for (const snap of snaps) if (snap.exists) nameByUid.set(snap.id, publicMemberName(snap.data()));
  }
  const eventIds = [...new Set(entries.map((e) => e.eventId).filter(Boolean))];
  const eventNameById = new Map<string, string>();
  if (eventIds.length) {
    const snaps = await db.getAll(...eventIds.map((id) => db.collection("events").doc(id)));
    for (const snap of snaps) if (snap.exists) eventNameById.set(snap.id, String((snap.data() as any)?.name || ""));
  }

  res.status(200).json({
    ok: true,
    category: args.category,
    itemId: args.itemId,
    history: {mode: args.historyMode, from: fromIso, to: todayIso},
    entries: entries.map((e) => ({
      startDate: e.startDate,
      endDate: e.endDate,
      source: e.source,
      userDisplayName: nameByUid.get(e.userUid) || "",
      isClubEvent: e.isClubEvent,
      eventName: e.eventId ? (eventNameById.get(e.eventId) || "") : "",
    })),
  });
}
