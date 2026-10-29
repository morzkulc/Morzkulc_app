import type {Request, Response} from "express";
import {listSeasonSessions, getUserEnrollments, computeSlotAvailability, resolveKayakLabelsBulk, getBasenVars, sessionSlotDatetimeMs, getAttendeesBySessionSlot, getAvailableKayaksBySessionSlot, getWaitlistsBySessionSlot, resolveBasenAdminGrant, todayIso} from "../modules/basen/basen_service";
import {getBasenGodzinyRecords, computeBasenGodzinyBalance} from "../modules/basen/basen_godziny_service";
import {computeSeason, loadSeasonEnrollments} from "../modules/basen/basen_season";
import {round2, seasonOf} from "../modules/basen/basen_finance";

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
 * GET /api/basen/sessions — wszystkie terminy sezonu (minione i odwołane też) z
 * wynikiem dla członków (odbył się / odwołany / zapisy vs minimum), bez kwot.
 * GET /api/basen/sessions?view=finance — panel „Finanse" (tylko zarząd/KR/opiekun basenu).
 */
export async function handleGetBasenSessions(req: Request, res: Response, deps: Deps): Promise<void> {
  if (deps.sendPreflight(req, res)) return;
  if (!deps.requireAllowedHost(req, res)) return;
  deps.setCorsHeaders(req, res);

  deps.corsHandler(req, res, async () => {
    try {
      if (req.method !== "GET") {
        res.status(405).json({error: "Method not allowed"});
        return;
      }

      const tokenCheck = await deps.requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }

      const uid = tokenCheck.decoded.uid;
      const isFinanceView = String(req.query?.view || "") === "finance";

      // Widok członka: odczyty niezależne od dokumentu użytkownika startują razem
      // z nim — wcześniej szły czterema etapami jeden po drugim (user → terminy →
      // reszta → etykiety kajaków), a ten endpoint zamyka ekran startowy.
      // catch: przy wczesnym return (403) obietnica nie jest już oczekiwana.
      const memberReads = isFinanceView ? null : Promise.all([
        listSeasonSessions(deps.db),
        getUserEnrollments(deps.db, uid),
        getBasenVars(deps.db),
        getBasenGodzinyRecords(deps.db, uid),
        getAttendeesBySessionSlot(deps.db),
        getWaitlistsBySessionSlot(deps.db),
      ]);
      memberReads?.catch(() => undefined);

      const userSnap = await deps.db.collection("users_active").doc(uid).get();
      if (!userSnap.exists) {
        res.status(403).json({error: "User not found"});
        return;
      }

      const userData = userSnap.data() as any;
      const isKursant = String(userData?.role_key || "") === "rola_kursant";

      if (isFinanceView || !memberReads) {
        const roleKey = String(userData?.role_key || "");
        if (!deps.adminRoleKeys.includes(roleKey) && !(await resolveBasenAdminGrant(deps.db, String(userData?.email || "")))) {
          res.status(403).json({error: "Brak uprawnień. Wymagana rola: zarząd/KR lub opiekun basenowy."});
          return;
        }
        res.status(200).json({ok: true, ...(await buildFinance(deps.db))});
        return;
      }

      const today = todayIso();
      const [sessions, userEnrollments, vars, godzinyRecords, attendeesByKey, waitlistsByKey] = await memberReads;
      const upcoming = sessions.filter((s) => s.date >= today);

      // Nazwa+numer wybranego kajaka zamiast surowego ID (patrz resolveKayakLabels) —
      // rozwiązywane raz dla wszystkich unikalnych ID własnych zapisów requestera.
      // Krótka wersja (bez marki) trafia na listę uczestników — TYLKO własny wiersz,
      // ma się zmieścić w jednym wierszu na mobile.
      const kayakIds = Array.from(new Set(
        userEnrollments.map((e) => e.kayakId).filter((id): id is string => Boolean(id) && id !== "PRIVATE")
      ));
      const [kayaksByKey, seasonEnrollments, kayakLabels] = await Promise.all([
        getAvailableKayaksBySessionSlot(deps.db, upcoming),
        loadSeasonEnrollments(deps.db, sessions),
        resolveKayakLabelsBulk(deps.db, kayakIds),
      ]);
      const userGodzinyBalance = computeBasenGodzinyBalance(godzinyRecords);
      const cancellationWindowMs = vars.basen_okno_anulowania_h * 60 * 60 * 1000;
      const season = computeSeason(sessions, seasonEnrollments, vars, today);
      const rowById = new Map(season.rows.map((r) => [r.id, r]));

      const enrollmentByKey = new Map(userEnrollments.map((e) => [`${e.sessionId}_${e.slot}`, e]));

      const resolveOwnKayakLabel = (kayakId: string | null | undefined): string | null => {
        if (!kayakId) return null;
        if (kayakId === "PRIVATE") return "Kajak prywatny";
        return kayakLabels.get(kayakId)?.full || null;
      };
      const resolveOwnKayakCompactLabel = (kayakId: string | null | undefined): string | null => {
        if (!kayakId) return null;
        if (kayakId === "PRIVATE") return "Prywatny";
        return kayakLabels.get(kayakId)?.compact || null;
      };

      const sessionsWithStatus = sessions.map((s) => {
        const isPast = s.date < today;
        const row = rowById.get(s.id);
        const slots: Record<string, any> = {};
        for (const [label, slot] of Object.entries(s.slots || {})) {
          if (!slot) continue;
          if (isPast) {
            // Minione terminy — tylko podsumowanie, bez zapisów i uczestników.
            slots[label] = {timeStart: slot.timeStart, timeEnd: slot.timeEnd, capacity: slot.capacity, enrolledCount: slot.enrolledCount, status: slot.status, reservedSpots: slot.reservedSpots || null};
            continue;
          }
          const key = `${s.id}_${label}`;
          const enrollment = enrollmentByKey.get(key) || null;
          const availability = computeSlotAvailability(slot, isKursant);
          const slotMs = sessionSlotDatetimeMs(s, slot);
          const waitlist = waitlistsByKey.get(key) || [];
          const myWaitIdx = waitlist.findIndex((w) => w.userUid === uid);
          slots[label] = {
            timeStart: slot.timeStart,
            timeEnd: slot.timeEnd,
            capacity: slot.capacity,
            enrolledCount: slot.enrolledCount,
            status: slot.status,
            reservedSpots: slot.reservedSpots || null,
            remaining: availability.remaining,
            isFull: availability.isFull,
            viaReservedPool: availability.viaReservedPool,
            isWithinCancellationWindow: slotMs > 0 && Date.now() + cancellationWindowMs > slotMs,
            userEnrolled: Boolean(enrollment),
            userEnrollmentType: enrollment?.type || null,
            userInstructorUid: enrollment?.instructorUid || null,
            userKayakId: enrollment?.kayakId || null,
            userKayakLabel: resolveOwnKayakLabel(enrollment?.kayakId),
            userKayakCompactLabel: resolveOwnKayakCompactLabel(enrollment?.kayakId),
            userViaReservedPool: enrollment?.viaReservedPool === true,
            waitlistCount: waitlist.length,
            userWaitlistPosition: myWaitIdx >= 0 ? myWaitIdx + 1 : null,
            attendees: attendeesByKey.get(key) || [],
            availableKayaks: kayaksByKey.get(key) || [],
          };
        }

        return {
          id: s.id,
          date: s.date,
          notes: s.notes,
          isPast,
          outcome: row?.outcome || "planned",
          cancelReason: row?.cancelReason || null,
          zapisy: row?.zapisy ?? 0,
          decisionAtMs: row?.decisionAtMs || 0,
          slots,
        };
      });

      res.status(200).json({
        ok: true,
        sessions: sessionsWithStatus,
        userGodzinyBalance,
        // Bez kwot — członkowie widzą tylko liczby terminów i oficjalne minimum.
        season: {
          key: season.summary.key,
          held: season.summary.held,
          cancelledLow: season.summary.cancelledLow,
          cancelledAdmin: season.summary.cancelledAdmin,
          upcoming: season.summary.planned + season.summary.confirmed,
          minZapisow: vars.basen_min_zapisow,
          maxDniNaprzod: vars.basen_max_dni_naprzod,
          oknoH: vars.basen_okno_anulowania_h,
        },
      });
    } catch (err) {
      const e = err as {message?: string};
      res.status(500).json({error: "Server error", message: e?.message || String(err)});
    }
  });
}

/** Panel „Finanse": wynik każdego terminu, wynik netto sezonu, sprzedaż godzin basenowych. */
async function buildFinance(db: FirebaseFirestore.Firestore) {
  const [sessions, vars, salesSnap] = await Promise.all([
    listSeasonSessions(db),
    getBasenVars(db),
    db.collection("basen_godziny_ledger").where("type", "==", "admin_add").get(),
  ]);
  const enrollments = await loadSeasonEnrollments(db, sessions);
  const {rows, summary} = computeSeason(sessions, enrollments, vars);

  const seasonStartMs = new Date(`${seasonOf(todayIso()).start}T00:00:00Z`).getTime();
  const sales = {jednorazowe: {count: 0, entries: 0, pln: 0}, karnet5: {count: 0, entries: 0, pln: 0}, karnet10: {count: 0, entries: 0, pln: 0}};
  for (const d of salesSnap.docs) {
    const r = d.data() as any;
    const ms = r?.createdAt?.toMillis ? r.createdAt.toMillis() : 0;
    const key = r?.product as keyof typeof sales;
    if (ms < seasonStartMs || !sales[key]) continue;
    sales[key].count++;
    sales[key].entries += Number(r.amount) || 0;
    sales[key].pln = round2(sales[key].pln + (Number(r.amountPln) || 0));
  }
  const salesPln = round2(sales.jednorazowe.pln + sales.karnet5.pln + sales.karnet10.pln);

  return {
    summary,
    rows,
    sales: {...sales, totalPln: salesPln},
    rules: {
      kosztTerminu: vars.basen_koszt_terminu,
      maxStrataTerminu: vars.basen_max_strata_terminu,
      budzetSezonu: vars.basen_budzet_sezonu,
      cenaWejscia: vars.basen_cena_za_godzine,
      minZapisow: vars.basen_min_zapisow,
      oknoH: vars.basen_okno_anulowania_h,
    },
  };
}
