/**
 * km_log_service.ts
 *
 * Logika zapisu wpisów aktywności (km_logs) i aktualizacji agregatów użytkownika (km_user_stats).
 *
 * Zasady:
 * - Punkty obliczane ON WRITE przez computePoints() z km_scoring.ts
 * - km_user_stats/{uid} aktualizowane atomicznie po każdym zapisie
 * - Dane historyczne traktowane jak append-only — brak nadpisywania
 */

import * as admin from "firebase-admin";
import {computePoints, CapsizeRolls, getYearFromDate, getSeasonKeyFromDate} from "./km_scoring";
import {KmVars} from "./km_vars";

export type WaterType = "mountains" | "lowlands" | "sea" | "track" | "pool"; // track = tor / playspot

export type KmLogInput = {
  uid: string;
  userSnapshot: {displayName: string; nickname: string; email: string};
  date: string; // "YYYY-MM-DD"
  waterType: WaterType;
  placeName: string; // canonical
  placeNameRaw: string; // raw input
  placeId?: string;
  lat?: number; // WGS84 — z km_places lub pinu użytkownika
  lng?: number; // WGS84
  sectionDescription?: string;
  km: number;
  hoursOnWater: number; // wymagane, może być 0 (np. brak pomiaru)
  difficultyScale?: "WW" | "U" | null;
  difficulty?: string | null; // "WW3", "U2", null, itd.
  capsizeRolls: CapsizeRolls;
  note?: string;
  eventId?: string;
  eventName?: string;
};

export type KmLog = KmLogInput & {
  logId: string;
  sourceType: "runtime";
  schemaVersion: 1;
  isPartial: false;
  year: number;
  seasonKey: string;
  pointsTotal: number;
  pointsBreakdown: {capsizeRolls: number};
  scoringVersion: string;
  visibility: "visible" | "hidden";
  deletedAt?: FirebaseFirestore.Timestamp;
  deletedBy?: string;
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
};

/**
 * Dodaje nowy wpis aktywności do km_logs i aktualizuje km_user_stats.
 * Zwraca ID nowo zapisanego dokumentu.
 */
function buildLogDoc(
  logId: string,
  input: KmLogInput,
  vars: KmVars,
  createdAt: FirebaseFirestore.Timestamp
): {logDoc: Record<string, any>; inc: StatsIncrement} {
  const year = getYearFromDate(input.date);
  const seasonKey = getSeasonKeyFromDate(input.date);
  const scoring = computePoints(input.capsizeRolls, vars);
  const now = admin.firestore.Timestamp.now();

  const logDoc: Record<string, any> = {
    logId,
    sourceType: "runtime",
    schemaVersion: 1,
    isPartial: false,
    uid: input.uid,
    userSnapshot: input.userSnapshot,
    date: input.date,
    year,
    seasonKey,
    waterType: input.waterType,
    placeName: input.placeName,
    placeNameRaw: input.placeNameRaw,
    km: input.km,
    capsizeRolls: {
      kabina: Math.max(0, Math.round(input.capsizeRolls.kabina || 0)),
      rolka: Math.max(0, Math.round(input.capsizeRolls.rolka || 0)),
      dziubek: Math.max(0, Math.round(input.capsizeRolls.dziubek || 0)),
    },
    pointsTotal: scoring.pointsTotal,
    pointsBreakdown: scoring.pointsBreakdown,
    scoringVersion: scoring.scoringVersion,
    visibility: "visible",
    hoursOnWater: input.hoursOnWater,
    createdAt,
    updatedAt: now,
  };

  // Opcjonalne pola — nie zapisuj undefined
  if (input.placeId) logDoc.placeId = input.placeId;
  if (input.lat != null) logDoc.lat = input.lat;
  if (input.lng != null) logDoc.lng = input.lng;
  if (input.sectionDescription) logDoc.sectionDescription = input.sectionDescription;
  if (input.difficultyScale) logDoc.difficultyScale = input.difficultyScale;
  if (input.difficulty) logDoc.difficulty = input.difficulty;
  if (input.note) logDoc.note = input.note;
  if (input.eventId) logDoc.eventId = input.eventId;
  if (input.eventName) logDoc.eventName = input.eventName;

  return {logDoc, inc: logToIncrement(logDoc)};
}

/** Wkład wpisu w agregaty (te same pola co przy zapisie). */
function logToIncrement(log: any): StatsIncrement {
  const rolls = log.capsizeRolls || {};
  return {
    km: Number(log.km) || 0,
    hoursOnWater: Number(log.hoursOnWater) || 0,
    pointsTotal: Number(log.pointsTotal) || 0,
    date: String(log.date || ""),
    year: Number(log.year) || getYearFromDate(String(log.date || "")),
    seasonKey: String(log.seasonKey || log.year || ""),
    capsizeRolls: {
      kabina: Math.max(0, parseInt(rolls.kabina || "0", 10)),
      rolka: Math.max(0, parseInt(rolls.rolka || "0", 10)),
      dziubek: Math.max(0, parseInt(rolls.dziubek || "0", 10)),
    },
    scoringVersion: String(log.scoringVersion || ""),
  };
}

export async function addKmLog(
  db: FirebaseFirestore.Firestore,
  input: KmLogInput,
  vars: KmVars
): Promise<string> {
  const logRef = db.collection("km_logs").doc();
  const {logDoc, inc} = buildLogDoc(logRef.id, input, vars, admin.firestore.Timestamp.now());
  const statsRef = db.collection("km_user_stats").doc(input.uid);

  await db.runTransaction(async (tx) => {
    const statsSnap = await tx.get(statsRef); // READ przed zapisami
    tx.set(logRef, logDoc);
    const existing = statsSnap.exists ? (statsSnap.data() as any) : null;
    tx.set(statsRef, computeStatsUpdate(existing, input.uid, input.userSnapshot, inc, 1), {merge: false});
  });

  return logRef.id;
}

export type KmLogChangeResult =
  | {ok: true; before: any}
  | {ok: false; code: "not_found" | "forbidden" | "historical"};

/**
 * Wczytuje wpis w transakcji i sprawdza, czy użytkownik może go zmienić:
 * tylko własny wpis i nie z archiwum (archiwum nadpisuje import z arkusza).
 */
async function readOwnLog(
  tx: FirebaseFirestore.Transaction,
  logRef: FirebaseFirestore.DocumentReference,
  uid: string
): Promise<{ok: true; log: any} | {ok: false; code: "not_found" | "forbidden" | "historical"}> {
  const snap = await tx.get(logRef);
  if (!snap.exists) return {ok: false, code: "not_found"};
  const log = snap.data() as any;
  if (log.uid !== uid) return {ok: false, code: "forbidden"};
  if (log.sourceType === "historical") return {ok: false, code: "historical"};
  return {ok: true, log};
}

/**
 * Edycja własnego wpisu: dokument zastępowany nowym (createdAt zachowane, punkty
 * przeliczone), agregaty = stare − wkład starego wpisu + wkład nowego (jedna transakcja).
 */
export async function updateKmLog(
  db: FirebaseFirestore.Firestore,
  logId: string,
  input: KmLogInput,
  vars: KmVars
): Promise<KmLogChangeResult> {
  const logRef = db.collection("km_logs").doc(logId);
  const statsRef = db.collection("km_user_stats").doc(input.uid);
  return db.runTransaction(async (tx) => {
    const own = await readOwnLog(tx, logRef, input.uid);
    if (!own.ok) return own;
    const statsSnap = await tx.get(statsRef);
    const {logDoc, inc} = buildLogDoc(logId, input, vars, own.log.createdAt || admin.firestore.Timestamp.now());
    const existing = statsSnap.exists ? (statsSnap.data() as any) : null;
    const without = computeStatsUpdate(existing, input.uid, input.userSnapshot, logToIncrement(own.log), -1);
    tx.set(logRef, logDoc);
    tx.set(statsRef, computeStatsUpdate(without, input.uid, input.userSnapshot, inc, 1), {merge: false});
    return {ok: true as const, before: own.log};
  });
}

/** Usunięcie własnego wpisu: dokument kasowany, agregaty pomniejszone o jego wkład. */
export async function deleteKmLog(
  db: FirebaseFirestore.Firestore,
  uid: string,
  logId: string
): Promise<KmLogChangeResult> {
  const logRef = db.collection("km_logs").doc(logId);
  const statsRef = db.collection("km_user_stats").doc(uid);
  return db.runTransaction(async (tx) => {
    const own = await readOwnLog(tx, logRef, uid);
    if (!own.ok) return own;
    const statsSnap = await tx.get(statsRef);
    const existing = statsSnap.exists ? (statsSnap.data() as any) : null;
    const snapshot = {
      displayName: existing?.displayName || own.log.userSnapshot?.displayName || "",
      nickname: existing?.nickname || own.log.userSnapshot?.nickname || "",
      email: own.log.userSnapshot?.email || "",
    };
    tx.delete(logRef);
    tx.set(statsRef, computeStatsUpdate(existing, uid, snapshot, logToIncrement(own.log), -1), {merge: false});
    return {ok: true as const, before: own.log};
  });
}

type StatsIncrement = {
  km: number;
  hoursOnWater: number;
  pointsTotal: number;
  date: string;
  year: number;
  seasonKey: string;
  capsizeRolls: {kabina: number; rolka: number; dziubek: number};
  scoringVersion: string;
};

/**
 * Nowy stan km_user_stats/{uid} po dodaniu (sign = 1) albo odjęciu (sign = −1) wkładu wpisu.
 * Wartości zaokrąglane do 0,01 i nie schodzą poniżej 0; rok bez wpisów znika z mapy years.
 */
export function computeStatsUpdate(
  existing: any,
  uid: string,
  userSnapshot: {displayName: string; nickname: string; email: string},
  incRaw: StatsIncrement,
  sign: 1 | -1
): Record<string, any> {
  const inc: StatsIncrement = {
    ...incRaw,
    km: sign * incRaw.km,
    hoursOnWater: sign * incRaw.hoursOnWater,
    pointsTotal: sign * incRaw.pointsTotal,
    capsizeRolls: {
      kabina: sign * incRaw.capsizeRolls.kabina,
      rolka: sign * incRaw.capsizeRolls.rolka,
      dziubek: sign * incRaw.capsizeRolls.dziubek,
    },
  };
  const n = (v: number) => Math.max(0, Math.round(v * 100) / 100);

  const currentYearKey = String(new Date().getFullYear());
  const incYear = String(inc.year);
  const incSeason = inc.seasonKey;

  const isSameYear = incYear === (existing?.yearKey || currentYearKey);
  const isSameSeason = incSeason === (existing?.seasonKey || currentYearKey);

  // Jeśli rok się zmienił — nie resetujemy (agregaty są kumulatywne per aktualny rok)
  // To znaczy year/season zawsze wskazują na AKTUALNY rok — starsze rekordy trafiają tylko do all-time
  // Uproszczenie MVP: yearKey = bieżący rok, nie rok wpisu
  const activeYear = currentYearKey;
  const activeSeason = currentYearKey;
  const isCurrentYear = incYear === activeYear;

  const base = existing || {
    uid,
    displayName: userSnapshot.displayName,
    nickname: userSnapshot.nickname,
    allTimeKm: 0,
    allTimeHours: 0,
    allTimeDays: 0,
    allTimePoints: 0,
    allTimeLogs: 0,
    allTimeCapsizeKabina: 0,
    allTimeCapsizeRolka: 0,
    allTimeCapsizeDziubek: 0,
    yearKey: activeYear,
    yearKm: 0,
    yearHours: 0,
    yearDays: 0,
    yearPoints: 0,
    yearLogs: 0,
    seasonKey: activeSeason,
    seasonKm: 0,
    seasonHours: 0,
    seasonDays: 0,
    seasonPoints: 0,
    seasonLogs: 0,
    scoringVersion: inc.scoringVersion,
  };

  const update: Record<string, any> = {
    uid,
    displayName: userSnapshot.displayName,
    nickname: userSnapshot.nickname,
    allTimeKm: n((base.allTimeKm || 0) + inc.km),
    allTimeHours: n((base.allTimeHours || 0) + inc.hoursOnWater),
    allTimeDays: n((base.allTimeDays || 0) + sign),
    allTimePoints: n((base.allTimePoints || 0) + inc.pointsTotal),
    allTimeLogs: n((base.allTimeLogs || 0) + sign),
    allTimeCapsizeKabina: n((base.allTimeCapsizeKabina || 0) + inc.capsizeRolls.kabina),
    allTimeCapsizeRolka: n((base.allTimeCapsizeRolka || 0) + inc.capsizeRolls.rolka),
    allTimeCapsizeDziubek: n((base.allTimeCapsizeDziubek || 0) + inc.capsizeRolls.dziubek),
    scoringVersion: inc.scoringVersion || base.scoringVersion || "",
    updatedAt: admin.firestore.Timestamp.now(),
  };

  // Aktualizuj agregaty roku/sezonu tylko jeśli wpis dotyczy bieżącego roku
  if (isCurrentYear) {
    update.yearKey = activeYear;
    update.yearKm = n((isSameYear ? (base.yearKm || 0) : 0) + inc.km);
    update.yearHours = n((isSameYear ? (base.yearHours || 0) : 0) + inc.hoursOnWater);
    update.yearDays = n((isSameYear ? (base.yearDays || 0) : 0) + sign);
    update.yearPoints = n((isSameYear ? (base.yearPoints || 0) : 0) + inc.pointsTotal);
    update.yearLogs = n((isSameYear ? (base.yearLogs || 0) : 0) + sign);
    update.seasonKey = activeSeason;
    update.seasonKm = n((isSameSeason ? (base.seasonKm || 0) : 0) + inc.km);
    update.seasonHours = n((isSameSeason ? (base.seasonHours || 0) : 0) + inc.hoursOnWater);
    update.seasonDays = n((isSameSeason ? (base.seasonDays || 0) : 0) + sign);
    update.seasonPoints = n((isSameSeason ? (base.seasonPoints || 0) : 0) + inc.pointsTotal);
    update.seasonLogs = n((isSameSeason ? (base.seasonLogs || 0) : 0) + sign);
  } else {
    // Wpis historyczny (inny rok) — nie nadpisuj bieżącego roku
    update.yearKey = base.yearKey || activeYear;
    update.yearKm = base.yearKm || 0;
    update.yearHours = base.yearHours || 0;
    update.yearDays = base.yearDays || 0;
    update.yearPoints = base.yearPoints || 0;
    update.yearLogs = base.yearLogs || 0;
    update.seasonKey = base.seasonKey || activeSeason;
    update.seasonKm = base.seasonKm || 0;
    update.seasonHours = base.seasonHours || 0;
    update.seasonDays = base.seasonDays || 0;
    update.seasonPoints = base.seasonPoints || 0;
    update.seasonLogs = base.seasonLogs || 0;
  }

  // Aktualizuj agregatów per-rok (years map)
  const existingYears: Record<string, any> = (existing?.years as any) || {};
  const incYearStr = String(inc.year);
  const yearEntry = existingYears[incYearStr] || {km: 0, hours: 0, days: 0, points: 0, logs: 0};
  const newYear = {
    km: n((yearEntry.km || 0) + inc.km),
    hours: n((yearEntry.hours || 0) + inc.hoursOnWater),
    days: n((yearEntry.days || 0) + sign),
    points: n((yearEntry.points || 0) + inc.pointsTotal),
    logs: n((yearEntry.logs || 0) + sign),
  };
  update.years = {...existingYears, [incYearStr]: newYear};
  if (newYear.logs <= 0) delete update.years[incYearStr];

  return update;
}

/**
 * Pobiera listę wpisów km_logs dla danego użytkownika.
 * Posortowane po dacie malejąco.
 */
export async function getUserKmLogs(
  db: FirebaseFirestore.Firestore,
  uid: string,
  limit = 50,
  afterDate?: string
): Promise<any[]> {
  let q = db.collection("km_logs")
    .where("uid", "==", uid)
    .orderBy("date", "desc")
    .limit(limit);

  if (afterDate) {
    q = q.startAfter(afterDate) as any;
  }

  const snap = await q.get();
  return snap.docs.map((d) => d.data());
}

/**
 * Pobiera agregaty użytkownika (km_user_stats).
 * Zwraca null jeśli użytkownik nie ma jeszcze żadnych wpisów.
 */
export async function getUserKmStats(
  db: FirebaseFirestore.Firestore,
  uid: string
): Promise<any | null> {
  const snap = await db.collection("km_user_stats").doc(uid).get();
  if (!snap.exists) return null;
  return snap.data() as any;
}
