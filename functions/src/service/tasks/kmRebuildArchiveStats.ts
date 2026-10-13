/**
 * kmRebuildArchiveStats.ts
 *
 * Task: km.rebuildArchiveStats
 *
 * Przelicza km_archive_stats — agregaty osób z archiwum kilometrówki, które nie mają konta
 * (km_logs z uid = "historical_unmatched": wiersze archiwum bez e-maila). Osoba = nazwa
 * z userSnapshot.displayName. Ranking (kmRankings) dokleja te agregaty do km_user_stats
 * w rankingach „Wszech czasów” i „Wybrany rok”; bieżącego roku archiwum nie dotyczy.
 *
 * Kształt dokumentu jak km_user_stats (allTime*, years{rok:{km,hours,days,points,logs}})
 * + archive: true. Dokumenty spoza nowego wyniku są usuwane (pełna przebudowa).
 *
 * Wywoływany: z km.rebuildRankings (menu arkusza archiwum) oraz ręcznie.
 * Payload: dry?: boolean
 */

import {ServiceTask} from "../types";

type Payload = {dry?: boolean};

// Nazwy z archiwum, które nie są osobami. „c”: 572 wiersze z lat 2013–2016, w 571 z nich
// km = data z kolumny daty (np. „6.01” → 6,01 km), a opis podaje inną liczbę km.
export const EXCLUDED_ARCHIVE_NAMES = new Set(["c"]);

export type ArchiveYear = {km: number; hours: number; days: number; points: number; logs: number};

export type ArchiveStats = {
  uid: string;
  archive: true;
  displayName: string;
  nickname: string;
  allTimeKm: number;
  allTimeHours: number;
  allTimePoints: number;
  allTimeDays: number;
  allTimeLogs: number;
  years: Record<string, ArchiveYear>;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

export function archiveSlug(name: string): string {
  return name
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l").replace(/Ł/g, "L")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Agreguje wpisy historical_unmatched per nazwa. Klucz dokumentu = "archive_" + slug nazwy. */
export function computeArchiveStats(logs: any[]): Record<string, ArchiveStats> {
  const out: Record<string, ArchiveStats> = {};
  for (const log of logs) {
    if (log?.uid !== "historical_unmatched") continue;
    const name = String(log.userSnapshot?.displayName || "").trim();
    if (!name || EXCLUDED_ARCHIVE_NAMES.has(name)) continue;
    const slug = archiveSlug(name);
    if (!slug) continue;
    const id = `archive_${slug}`;
    const s = out[id] || (out[id] = {
      uid: id,
      archive: true,
      displayName: name,
      nickname: String(log.userSnapshot?.nickname || "").trim(),
      allTimeKm: 0, allTimeHours: 0, allTimePoints: 0, allTimeDays: 0, allTimeLogs: 0,
      years: {},
    });
    const km = Number(log.km) || 0;
    const hours = Number(log.hoursOnWater) || 0;
    const points = Number(log.pointsTotal) || 0;
    s.allTimeKm += km;
    s.allTimeHours += hours;
    s.allTimePoints += points;
    s.allTimeDays += 1; // jak km.rebuildUserStats: dzień = wpis
    s.allTimeLogs += 1;
    const year = String(log.year || String(log.date || "").slice(0, 4));
    if (/^\d{4}$/.test(year)) {
      const y = s.years[year] || (s.years[year] = {km: 0, hours: 0, days: 0, points: 0, logs: 0});
      y.km += km; y.hours += hours; y.points += points; y.days += 1; y.logs += 1;
    }
  }
  for (const s of Object.values(out)) {
    s.allTimeKm = r2(s.allTimeKm);
    s.allTimeHours = r2(s.allTimeHours);
    s.allTimePoints = r2(s.allTimePoints);
    for (const y of Object.values(s.years)) {
      y.km = r2(y.km); y.hours = r2(y.hours); y.points = r2(y.points);
    }
  }
  return out;
}

export const kmRebuildArchiveStatsTask: ServiceTask<Payload> = {
  id: "km.rebuildArchiveStats",
  description: "Przelicza km_archive_stats (osoby z archiwum bez konta) z km_logs historical_unmatched.",

  validate: () => {
    // Brak wymaganych pól
  },

  run: async (payload, ctx) => {
    const dryRun = ctx.dryRun || Boolean(payload?.dry);
    const db = ctx.firestore;

    const logsSnap = await db.collection("km_logs")
      .where("uid", "==", "historical_unmatched")
      .select("uid", "userSnapshot", "km", "hoursOnWater", "pointsTotal", "year", "date")
      .get();
    const stats = computeArchiveStats(logsSnap.docs.map((d) => d.data()));
    const ids = new Set(Object.keys(stats));

    const existing = await db.collection("km_archive_stats").select().get();
    const toDelete = existing.docs.filter((d) => !ids.has(d.id));

    ctx.logger.info("km.rebuildArchiveStats", {logs: logsSnap.size, people: ids.size, deleted: toDelete.length, dryRun});

    if (!dryRun) {
      // ~150 osób — zwykłe zapisy w paczkach po 50 wystarczą.
      const writes: Array<() => Promise<unknown>> = [
        ...Object.entries(stats).map(([id, s]) => () => db.collection("km_archive_stats").doc(id).set(s)),
        ...toDelete.map((d) => () => d.ref.delete()),
      ];
      for (let i = 0; i < writes.length; i += 50) {
        await Promise.all(writes.slice(i, i + 50).map((w) => w()));
      }
    }

    return {
      ok: true,
      message: `people=${ids.size}, logs=${logsSnap.size}, deleted=${toDelete.length}`,
      details: {people: ids.size, logs: logsSnap.size, deleted: toDelete.length, dryRun},
    };
  },
};
