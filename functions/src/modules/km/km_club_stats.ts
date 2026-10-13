/**
 * km_club_stats.ts
 *
 * „Moje statystyki na tle klubu” (zakładka Moje statystyki w module Ranking).
 * Rok kalendarzowy — te same agregaty co ranking „Bieżący rok” (km_user_stats.years[rok]).
 *
 * - porównanie: moja wartość, miejsce, liczba aktywnych (wartość > 0), średnia i mediana
 *   aktywnych, maksimum — per metryka (km, godziny, punkty, dni, wpisy),
 * - moje miesiące: suma km / godzin / punktów / wpisów z km_logs danego roku.
 */

export const CLUB_METRICS = ["km", "hours", "points", "days", "logs"] as const;
export type ClubMetric = typeof CLUB_METRICS[number];

export type ClubMetricStats = {
  me: number;
  rank: number | null; // null = brak aktywności w tej metryce
  active: number;
  avg: number;
  median: number;
  max: number;
};

export type MonthStats = {km: number; hours: number; points: number; logs: number};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Czysta funkcja: porównanie jednego użytkownika z resztą na podstawie years[rok]. */
export function computeClubComparison(
  statsDocs: Array<{uid?: string; years?: Record<string, any>}>,
  uid: string,
  year: string
): Record<ClubMetric, ClubMetricStats> {
  const out = {} as Record<ClubMetric, ClubMetricStats>;
  for (const metric of CLUB_METRICS) {
    const values: number[] = [];
    let me = 0;
    for (const doc of statsDocs) {
      const v = Number(doc.years?.[year]?.[metric]) || 0;
      if (doc.uid === uid) me = v;
      if (v > 0) values.push(v);
    }
    values.sort((a, b) => b - a);
    const n = values.length;
    const mid = Math.floor(n / 2);
    out[metric] = {
      me: r2(me),
      rank: me > 0 ? values.filter((v) => v > me).length + 1 : null,
      active: n,
      avg: n ? r2(values.reduce((s, v) => s + v, 0) / n) : 0,
      median: n ? r2(n % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2) : 0,
      max: n ? r2(values[0]) : 0,
    };
  }
  return out;
}

/** Czysta funkcja: miesiące 1–12 (indeks 0–11) z wpisów danego roku. */
export function computeMonths(logs: Array<{date?: string; km?: number; hoursOnWater?: number; pointsTotal?: number}>): MonthStats[] {
  const months: MonthStats[] = Array.from({length: 12}, () => ({km: 0, hours: 0, points: 0, logs: 0}));
  for (const log of logs) {
    const m = parseInt(String(log.date || "").slice(5, 7), 10);
    if (!(m >= 1 && m <= 12)) continue;
    const t = months[m - 1];
    t.km = r2(t.km + (Number(log.km) || 0));
    t.hours = r2(t.hours + (Number(log.hoursOnWater) || 0));
    t.points = r2(t.points + (Number(log.pointsTotal) || 0));
    t.logs += 1;
  }
  return months;
}

export async function getKmClubStats(
  db: FirebaseFirestore.Firestore,
  uid: string,
  year: number
): Promise<{year: number; metrics: Record<ClubMetric, ClubMetricStats>; months: MonthStats[]}> {
  const yearKey = String(year);
  const [statsSnap, logsSnap] = await Promise.all([
    db.collection("km_user_stats").select("uid", "years").get(),
    db.collection("km_logs")
      .where("uid", "==", uid)
      .where("year", "==", year)
      .select("date", "km", "hoursOnWater", "pointsTotal")
      .get(),
  ]);
  const statsDocs = statsSnap.docs.map((d) => ({uid: d.id, ...(d.data() as any)}));
  return {
    year,
    metrics: computeClubComparison(statsDocs, uid, yearKey),
    months: computeMonths(logsSnap.docs.map((d) => d.data() as any)),
  };
}
