/**
 * kmRankingsHandler.ts
 *
 * GET /kmRankings
 *
 * Zwraca ranking użytkowników na podstawie km_user_stats.
 * Dane gotowe — brak przeliczania ON READ.
 *
 * Query params:
 *   type?    — "km" | "points" | "hours" (domyślnie "km")
 *   period?  — "year" | "alltime" (domyślnie "alltime")
 *   limit?   — max liczba wyników (domyślnie 50, max 100)
 *
 * Ranking "year" — dotyczy bieżącego roku (yearKm, yearPoints, yearHours).
 * Ranking "alltime" — wszystkie czasy (allTimeKm, allTimePoints, allTimeHours).
 * Ranking "specificYear" — years[rok] z km_user_stats.
 *
 * „Wszech czasów” i „Wybrany rok” obejmują też osoby z archiwum bez konta
 * (km_archive_stats, entry.archive = true, budowane przez km.rebuildArchiveStats).
 *
 * Firestore wymaga indeksów złożonych na polach (allTimeKm DESC), (yearKm DESC), itp.
 */

import type {Request, Response} from "express";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; name?: string}};

export type KmRankingsDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
};

const VALID_TYPES = new Set(["km", "points", "hours"]);
const VALID_PERIODS = new Set(["year", "alltime", "specificYear"]);

function toEntry(data: any, value: number) {
  return {
    uid: data.uid,
    displayName: data.displayName || "",
    nickname: data.nickname || "",
    value,
    archive: data.archive === true,
    allTimeKm: data.allTimeKm || 0,
    allTimePoints: data.allTimePoints || 0,
    allTimeHours: data.allTimeHours || 0,
    yearKm: data.yearKm || 0,
    yearPoints: data.yearPoints || 0,
    yearHours: data.yearHours || 0,
    yearKey: data.yearKey || "",
    allTimeLogs: data.allTimeLogs || 0,
  };
}

type Entry = ReturnType<typeof toEntry>;

function rankEntries(entries: Entry[], limit: number) {
  return entries
    .filter((e) => e.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
    .map((e, i) => ({rank: i + 1, ...e}));
}

function resolveOrderField(type: string, period: string): string {
  if (period === "year") {
    if (type === "km") return "yearKm";
    if (type === "points") return "yearPoints";
    if (type === "hours") return "yearHours";
  }
  // alltime
  if (type === "km") return "allTimeKm";
  if (type === "points") return "allTimePoints";
  if (type === "hours") return "allTimeHours";
  return "allTimeKm";
}

export async function handleKmRankings(
  req: Request,
  res: Response,
  deps: KmRankingsDeps
): Promise<void> {
  if (deps.sendPreflight(req, res)) return;
  if (!deps.requireAllowedHost(req, res)) return;
  deps.setCorsHeaders(req, res);

  deps.corsHandler(req, res, async () => {
    if (req.method !== "GET") {
      res.status(405).json({error: "Method not allowed"});
      return;
    }

    try {
      const tokenCheck = await deps.requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }

      const typeRaw = String(req.query.type || "km").trim();
      const periodRaw = String(req.query.period || "alltime").trim();
      const limitRaw = parseInt(String(req.query.limit || "50"), 10);
      const limit = Math.min(100, Math.max(1, Number.isNaN(limitRaw) ? 50 : limitRaw));
      const yearRaw = String(req.query.year || "").trim();

      const type = VALID_TYPES.has(typeRaw) ? typeRaw : "km";
      const period = VALID_PERIODS.has(periodRaw) ? periodRaw : "alltime";
      const isSpecificYear = period === "specificYear" && /^\d{4}$/.test(yearRaw);

      // Ranking dla konkretnego roku — in-memory sort (klub < 200 członków, brak indeksu)
      if (isSpecificYear) {
        const metricKey = type === "km" ? "km" : type === "points" ? "points" : "hours";
        const [allSnap, archiveSnap] = await Promise.all([
          deps.db.collection("km_user_stats").get(),
          deps.db.collection("km_archive_stats").get(),
        ]);
        const entries = rankEntries(
          [...allSnap.docs, ...archiveSnap.docs].map((d) => {
            const data = d.data() as any;
            return toEntry(data, Number(data.years?.[yearRaw]?.[metricKey]) || 0);
          }),
          limit
        );
        res.status(200).json({
          ok: true,
          type,
          period: "specificYear",
          year: yearRaw,
          orderField: `years.${yearRaw}.${metricKey}`,
          entries,
          count: entries.length,
        });
        return;
      }

      const orderField = resolveOrderField(type, period);

      const topQuery = (collection: string) => deps.db.collection(collection)
        .orderBy(orderField, "desc")
        .where(orderField, ">", 0)
        .limit(limit)
        .get();
      // Archiwum nie ma danych z bieżącego roku — doklejane tylko do „Wszech czasów”.
      const [snap, archiveSnap] = await Promise.all([
        topQuery("km_user_stats"),
        period === "alltime" ? topQuery("km_archive_stats") : Promise.resolve(null),
      ]);

      const entries = rankEntries(
        [...snap.docs, ...(archiveSnap?.docs || [])].map((d) => {
          const data = d.data() as any;
          return toEntry(data, Number(data[orderField]) || 0);
        }),
        limit
      );

      res.status(200).json({
        ok: true,
        type,
        period,
        orderField,
        entries,
        count: entries.length,
      });
    } catch (err: any) {
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
