/**
 * Testy jednostkowe TS modułu Kilometrówka (0% pokrycia wg audytu 09.09, sekcja 4.4).
 * Wykonują PRODUKCYJNY kod km_scoring.ts / km_vars.ts / km_places_service.ts:
 *  - computePoints — punkty liczone ON WRITE (zaokrąglenia, wartości ujemne/ułamkowe),
 *  - getYearFromDate / getSeasonKeyFromDate,
 *  - getKmVars — odczyt setup/vars_kurs z fallbackami,
 *  - tokenizeName — tokeny do wyszukiwania akwenów (array-contains).
 *
 * Uruchamianie: npm --prefix functions run test
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {computePoints, getYearFromDate, getSeasonKeyFromDate} from "../src/modules/km/km_scoring";
import {getKmVars, KmVars} from "../src/modules/km/km_vars";
import {tokenizeName} from "../src/modules/km/km_places_service";
import {kmRebuildMapDataTask} from "../src/service/tasks/kmRebuildMapData";
import {handleKmAddLog} from "../src/api/kmAddLogHandler";
import {handleKmPlaces} from "../src/api/kmPlacesHandler";
import {handleKmEventStats} from "../src/api/kmEventStatsHandler";
import {computeClubComparison, computeMonths, getKmClubStats} from "../src/modules/km/km_club_stats";
import {computeArchiveStats, kmRebuildArchiveStatsTask} from "../src/service/tasks/kmRebuildArchiveStats";
import {handleKmRankings} from "../src/api/kmRankingsHandler";

const VARS: KmVars = {ptsKabina: 1, ptsEskimoska: 0.5, ptsDziubek: 0.25, scoringVersion: "v1"};

describe("computePoints", () => {
  it("kabina·1 + rolka·0.5 + dziubek·0.25; breakdown == total; wersja punktacji przepisana", () => {
    expect(computePoints({kabina: 2, rolka: 1, dziubek: 1}, VARS)).toEqual({
      pointsTotal: 2.75,
      pointsBreakdown: {capsizeRolls: 2.75},
      scoringVersion: "v1",
    });
  });

  it("same zera → 0; wartości ujemne clampowane do 0", () => {
    expect(computePoints({kabina: 0, rolka: 0, dziubek: 0}, VARS).pointsTotal).toBe(0);
    expect(computePoints({kabina: -3, rolka: -1, dziubek: 4}, VARS).pointsTotal).toBe(1);
  });

  it("liczniki ułamkowe zaokrąglane do całości przed przeliczeniem (1.4→1, 1.5→2)", () => {
    expect(computePoints({kabina: 1.4, rolka: 0, dziubek: 0}, VARS).pointsTotal).toBe(1);
    expect(computePoints({kabina: 1.5, rolka: 0, dziubek: 0}, VARS).pointsTotal).toBe(2);
  });

  it("brakujące pola (undefined/NaN) traktowane jako 0", () => {
    expect(computePoints({kabina: undefined as any, rolka: NaN, dziubek: null as any}, VARS).pointsTotal).toBe(0);
  });

  it("wynik zaokrąglony do 2 miejsc — brak artefaktów float (0.1·3 = 0.3, nie 0.30000000000000004)", () => {
    const v: KmVars = {...VARS, ptsEskimoska: 0.1};
    expect(computePoints({kabina: 0, rolka: 3, dziubek: 0}, v).pointsTotal).toBe(0.3);
    const v2: KmVars = {...VARS, ptsDziubek: 1 / 3};
    expect(computePoints({kabina: 0, rolka: 0, dziubek: 1}, v2).pointsTotal).toBe(0.33);
  });

  it("stawki z arkusza inne niż domyślne są respektowane", () => {
    const v: KmVars = {ptsKabina: 3, ptsEskimoska: 2, ptsDziubek: 1, scoringVersion: "v2"};
    const r = computePoints({kabina: 1, rolka: 1, dziubek: 1}, v);
    expect(r.pointsTotal).toBe(6);
    expect(r.scoringVersion).toBe("v2");
  });
});

describe("getYearFromDate / getSeasonKeyFromDate", () => {
  it("rok z daty ISO; sezon = rok (MVP)", () => {
    expect(getYearFromDate("2026-05-01")).toBe(2026);
    expect(getSeasonKeyFromDate("2026-05-01")).toBe("2026");
  });

  it("niepoprawna data → bieżący rok (fallback), sezon = surowy prefiks", () => {
    expect(getYearFromDate("")).toBe(new Date().getFullYear());
    expect(getYearFromDate("abcd-01-01")).toBe(new Date().getFullYear());
    expect(getSeasonKeyFromDate("")).toBe("");
  });
});

describe("getKmVars — setup/vars_kurs", () => {
  it("brak dokumentu → 1 / 0.5 / 0.25 / v1", async () => {
    expect(await getKmVars(new FakeFirestore().asDb())).toEqual({ptsKabina: 1, ptsEskimoska: 0.5, ptsDziubek: 0.25, scoringVersion: "v1"});
  });

  it("wartości z arkusza (także jako stringi); nieparsowalne → fallback", async () => {
    const db = new FakeFirestore({setup: [{_docId: "vars_kurs", vars: {"kabina_punkty": {value: "2"}, "eskimoska_punkty": {value: 1}, "dziubek_punkty": {value: "abc"}}}]}).asDb();
    expect(await getKmVars(db)).toEqual({ptsKabina: 2, ptsEskimoska: 1, ptsDziubek: 0.25, scoringVersion: "v1"});
  });
});

describe("tokenizeName — tokeny wyszukiwania akwenów", () => {
  it("pełna nazwa + słowa + prefiksy słów (min 2 znaki), wszystko lowercase", () => {
    const t = tokenizeName("Rzeka Radunia");
    expect(t[0]).toBe("rzeka radunia");
    for (const expected of ["rzeka", "radunia", "rz", "rze", "rzek", "ra", "rad", "radu", "radun", "raduni"]) {
      expect(t).toContain(expected);
    }
    expect(t.some((x) => x.length < 2)).toBe(false);
    expect(new Set(t).size).toBe(t.length);
  });

  it("pojedyncze słowo: brak duplikatu pełnej nazwy i słowa", () => {
    expect(tokenizeName("BRDA")).toEqual(["brda", "br", "brd"]);
  });

  it("puste / białe znaki → []", () => {
    expect(tokenizeName("")).toEqual([]);
    expect(tokenizeName("   ")).toEqual([]);
  });

  it("wielokrotne spacje/tabulatory wewnątrz nazwy zwijane do pojedynczej spacji w tokenie pełnej nazwy", () => {
    const t = tokenizeName("  Jezioro   Wdzydze ");
    expect(t[0]).toBe("jezioro wdzydze");
    expect(t).not.toContain("jezioro   wdzydze");
    expect(t).toContain("jezioro");
    expect(t).toContain("wdzydze");
    expect(tokenizeName("Rzeka\tRadunia")[0]).toBe("rzeka radunia");
  });

  it("limit 50 tokenów dla bardzo długich nazw", () => {
    const long = Array.from({length: 12}, (_, i) => `slowo${i}dlugie`).join(" ");
    expect(tokenizeName(long)).toHaveLength(50);
  });
});

// ─── km.rebuildMapData: współrzędne z wpisu lub z km_places ─────────────────────

describe("km.rebuildMapData — źródło współrzędnych", () => {
  it("wpis bez lat/lng bierze współrzędne miejsca; bez obu → pominięty", async () => {
    const db = new FakeFirestore({
      km_places: [
        {_docId: "pA", name: "Radunia", lat: 54.3, lng: 18.4},
        {_docId: "pB", name: "Ciunowo tor"},
      ],
      km_logs: [
        {uid: "u1", date: "2026-09-01", placeName: "Własne", lat: 50.1, lng: 19.9, userSnapshot: {nickname: "Jan"}},
        {uid: "u2", date: "2026-09-02", placeName: "Radunia", placeId: "pA", userSnapshot: {nickname: "Ola"}},
        {uid: "u3", date: "2026-09-03", placeName: "Ciunowo tor", placeId: "pB", userSnapshot: {nickname: "Ewa"}},
      ],
    });
    const ctx: any = {firestore: db, logger: {info: () => undefined, warn: () => undefined, error: () => undefined}};
    await kmRebuildMapDataTask.run({} as any, ctx);
    const cache = (await db.collection("km_map_cache").doc("v1").get()).data() as any;
    const names = cache.locations.map((l: any) => l.placeName).sort();
    expect(names).toEqual(["Radunia", "Własne"]);
    const radunia = cache.locations.find((l: any) => l.placeName === "Radunia");
    expect([radunia.lat, radunia.lng]).toEqual([54.3, 18.4]);
  });
});

// ─── POST /api/km/log/add: lokalizacja wymagana (od 12.10.2026) ──────────────────

async function runAddLog(db: FakeFirestore, body: Record<string, any>) {
  const out: {status: number; body: any} = {status: 0, body: null};
  const res: any = {
    status(s: number) {
      out.status = s;
      return res;
    },
    json(b: any) {
      out.body = b;
      return res;
    },
  };
  let inner: Promise<void> = Promise.resolve();
  await handleKmAddLog({method: "POST", body} as any, res, {
    db: db as any,
    sendPreflight: () => false,
    requireAllowedHost: () => true,
    setCorsHeaders: () => undefined,
    corsHandler: (_req: any, _res: any, next: () => Promise<void>) => {
      inner = next();
    },
    requireIdToken: async () => ({decoded: {uid: "u1", email: "u1@x.pl"}}),
    memberRoleKeys: ["rola_czlonek"],
  } as any);
  await inner;
  return out;
}

function addLogDb(): FakeFirestore {
  return new FakeFirestore({
    users_active: [{_docId: "u1", role_key: "rola_czlonek", email: "u1@x.pl", profile: {firstName: "Jan", lastName: "K"}}],
    km_places: [
      {_docId: "pWithLL", name: "Radunia", lat: 54.3, lng: 18.4, useCount: 5},
      {_docId: "pNoLL", name: "Bez Współrzędnych", useCount: 1},
    ],
  });
}

const baseLog = {date: "2026-09-01", waterType: "sea", km: 5, hoursOnWater: 1, capsizeRolls: {kabina: 0, rolka: 0, dziubek: 0}};
const placesCount = async (db: FakeFirestore) => (await db.collection("km_places").get()).size;
const logs = async (db: FakeFirestore) => (await db.collection("km_logs").get()).docs.map((d) => d.data() as any);

describe("kmAddLog — trudność/uciążliwość wymagana", () => {
  it("góry bez trudności → 400 difficulty_required, nic nie zapisane", async () => {
    const db = addLogDb();
    const r = await runAddLog(db, {...baseLog, waterType: "mountains", placeName: "Radunia"});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("difficulty_required");
    expect(await logs(db)).toEqual([]);
  });

  it("niziny bez uciążliwości → 400 difficulty_required", async () => {
    const db = addLogDb();
    const r = await runAddLog(db, {...baseLog, waterType: "lowlands", placeName: "Radunia"});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("difficulty_required");
  });

  it("niziny z U2 → zapisane", async () => {
    const db = addLogDb();
    const r = await runAddLog(db, {...baseLog, waterType: "lowlands", placeName: "Radunia", difficultyScale: "U", difficulty: "U2"});
    expect(r.status).toBe(200);
    expect((await logs(db))[0].difficulty).toBe("U2");
  });
});

describe("kmAddLog — tor / basen bez kilometrów", () => {
  it("tor (także stary 'playspot') i basen → km zapisane jako 0, morze zachowuje km", async () => {
    const db = addLogDb();
    for (const waterType of ["track", "playspot", "pool", "sea"]) {
      const r = await runAddLog(db, {...baseLog, waterType, km: 7.5, placeName: "Radunia"});
      expect(r.status).toBe(200);
    }
    const byType = (await logs(db)).map((l) => [l.waterType, l.km]).sort();
    expect(byType).toEqual([["pool", 0], ["sea", 7.5], ["track", 0], ["track", 0]]);
  });
});

describe("kmAddLog — lokalizacja wymagana", () => {
  it("nowa nazwa bez lokalizacji → 400 location_required, nic nie zapisane (także w słowniku)", async () => {
    const db = addLogDb();
    const r = await runAddLog(db, {...baseLog, placeName: "Nowe Jezioro"});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("location_required");
    expect(await placesCount(db)).toBe(2);
    expect(await logs(db)).toEqual([]);
  });

  it("miejsce ze słownika bez współrzędnych i bez lokalizacji we wpisie → 400", async () => {
    const r = await runAddLog(addLogDb(), {...baseLog, placeName: "Bez Współrzędnych", placeId: "pNoLL"});
    expect(r.status).toBe(400);
  });

  it("miejsce ze słownika ze współrzędnymi (po nazwie, bez placeId) → wpis dostaje współrzędne miejsca", async () => {
    const db = addLogDb();
    const r = await runAddLog(db, {...baseLog, placeName: "Radunia"});
    expect(r.status).toBe(200);
    const [l] = await logs(db);
    expect([l.lat, l.lng, l.placeId]).toEqual([54.3, 18.4, "pWithLL"]);
  });

  it("nowa nazwa z GPS → nowe miejsce w słowniku od razu ze współrzędnymi", async () => {
    const db = addLogDb();
    const r = await runAddLog(db, {...baseLog, placeName: "Nowe Jezioro", lat: 50.1, lng: 19.9});
    expect(r.status).toBe(200);
    const p = (await db.collection("km_places").get()).docs.map((d) => d.data() as any).find((x) => x.name === "Nowe Jezioro");
    expect([p.lat, p.lng]).toEqual([50.1, 19.9]);
  });

  it("formularz kursanta (source=kursant_form) bez lokalizacji → zapisany", async () => {
    const db = addLogDb();
    const r = await runAddLog(db, {...baseLog, waterType: "lowlands", km: 0, placeName: "Kurs – basen", eventId: "e1", eventName: "Kurs – basen", source: "kursant_form"});
    expect(r.status).toBe(200);
  });
});

// ─── GET /api/km/places?all=1: cały słownik do filtrowania po stronie klienta ─────

describe("kmPlaces ?all=1", () => {
  it("zwraca wszystkie miejsca z aliasami i współrzędnymi, bez searchTerms; pomija wpisy bez nazwy", async () => {
    const db = new FakeFirestore();
    await db.collection("km_places").doc("p1").set({name: "Wda", aliases: ["Czarna Woda"], searchTerms: ["wda"], useCount: 4, lat: 53.9, lng: 18.2, waterType: "lowlands"});
    await db.collection("km_places").doc("p2").set({name: "Puck", useCount: 1});
    await db.collection("km_places").doc("p3").set({name: "  ", useCount: 0});

    const out: {status: number; body: any} = {status: 0, body: null};
    const res: any = {
      status(s: number) {
        out.status = s;
        return res;
      },
      json(b: any) {
        out.body = b;
        return res;
      },
    };
    let inner: Promise<void> = Promise.resolve();
    await handleKmPlaces({method: "GET", query: {all: "1"}} as any, res, {
      db: db as any,
      sendPreflight: () => false,
      requireAllowedHost: () => true,
      setCorsHeaders: () => undefined,
      corsHandler: (_req: any, _res: any, next: () => Promise<void>) => {
        inner = next();
      },
      requireIdToken: async () => ({decoded: {uid: "u1"}}),
    });
    await inner;

    expect(out.status).toBe(200);
    expect(out.body.count).toBe(2);
    const wda = out.body.places.find((p: any) => p.placeId === "p1");
    expect(wda).toEqual({placeId: "p1", name: "Wda", aliases: ["Czarna Woda"], waterType: "lowlands", useCount: 4, lat: 53.9, lng: 18.2});
    const puck = out.body.places.find((p: any) => p.placeId === "p2");
    expect(puck.lat).toBeUndefined();
    expect(puck.aliases).toEqual([]);
  });
});

// ─── GET /api/km/event-stats?list=1: imprezy z wpisami ───────────────────────────

describe("kmEventStats ?list=1", () => {
  it("zwraca tylko imprezy z wpisami przypisanymi do użytkownika; wpisy bez eventId i historical_unmatched pomijane", async () => {
    const db = new FakeFirestore();
    await db.collection("km_logs").doc("l1").set({uid: "u1", eventId: "ev1", km: 10.5, hoursOnWater: 2, pointsTotal: 0.25});
    await db.collection("km_logs").doc("l2").set({uid: "u2", eventId: "ev1", km: 4, pointsTotal: 1});
    await db.collection("km_logs").doc("l2b").set({uid: "u2", eventId: "ev1", km: 1});
    await db.collection("km_logs").doc("l3").set({uid: "historical_unmatched", eventId: "ev2"});
    await db.collection("km_logs").doc("l4").set({uid: "u1"});
    await db.collection("km_logs").doc("l5").set({uid: "u3", eventId: "ev3"});

    const out: {status: number; body: any} = {status: 0, body: null};
    const res: any = {
      status(s: number) {
        out.status = s;
        return res;
      },
      json(b: any) {
        out.body = b;
        return res;
      },
    };
    let inner: Promise<void> = Promise.resolve();
    await handleKmEventStats({method: "GET", query: {list: "1"}} as any, res, {
      db: db as any,
      sendPreflight: () => false,
      requireAllowedHost: () => true,
      setCorsHeaders: () => undefined,
      corsHandler: (_req: any, _res: any, next: () => Promise<void>) => {
        inner = next();
      },
      requireIdToken: async () => ({decoded: {uid: "u1"}}),
    });
    await inner;

    expect(out.status).toBe(200);
    expect(out.body.eventIds.sort()).toEqual(["ev1", "ev3"]);
    expect(out.body.summaries.ev1).toEqual({participants: 2, logs: 3, km: 15.5, hours: 2, points: 1.25});
  });
});

describe("km_club_stats — moje statystyki na tle klubu", () => {
  const docs = [
    {uid: "a", years: {"2026": {km: 100, hours: 10, points: 2, days: 5, logs: 5}}},
    {uid: "me", years: {"2026": {km: 40, hours: 10, points: 0, days: 3, logs: 3}}},
    {uid: "b", years: {"2026": {km: 20, hours: 4, points: 1.25, days: 2, logs: 2}}},
    {uid: "c", years: {"2025": {km: 500}}},
  ];

  it("miejsce, liczba aktywnych, średnia/mediana/max liczone tylko z aktywnych w danym roku", () => {
    const m = computeClubComparison(docs, "me", "2026");
    expect(m.km).toEqual({me: 40, rank: 2, active: 3, avg: 53.33, median: 40, max: 100});
    expect(m.hours.rank).toBe(1); // ex aequo z „a” — miejsce dzielone
    expect(m.points).toEqual({me: 0, rank: null, active: 2, avg: 1.63, median: 1.63, max: 2});
  });

  it("brak aktywności w roku → zera, rank null", () => {
    const m = computeClubComparison(docs, "c", "2026");
    expect(m.km.me).toBe(0);
    expect(m.km.rank).toBeNull();
  });

  it("miesiące sumowane z dat wpisów, punkty z dokładnością 0,01", () => {
    const months = computeMonths([
      {date: "2026-05-02", km: 10, hoursOnWater: 2, pointsTotal: 0.25},
      {date: "2026-05-20", km: 5.5, hoursOnWater: 1, pointsTotal: 0.25},
      {date: "2026-09-01", km: 3},
      {date: "zła"},
    ]);
    expect(months[4]).toEqual({km: 15.5, hours: 3, points: 0.5, logs: 2});
    expect(months[8].logs).toBe(1);
    expect(months.reduce((s, m) => s + m.logs, 0)).toBe(3);
  });

  it("getKmClubStats czyta km_user_stats i wpisy użytkownika tylko z danego roku", async () => {
    const db = new FakeFirestore({
      km_user_stats: docs.map((d) => ({_docId: d.uid, ...d})),
      km_logs: [
        {_docId: "l1", uid: "me", year: 2026, date: "2026-03-01", km: 7},
        {_docId: "l2", uid: "me", year: 2025, date: "2025-03-01", km: 9},
        {_docId: "l3", uid: "a", year: 2026, date: "2026-03-01", km: 11},
      ],
    });
    const r = await getKmClubStats(db as any, "me", 2026);
    expect(r.metrics.km.rank).toBe(2);
    expect(r.months[2]).toEqual({km: 7, hours: 0, points: 0, logs: 1});
  });
});

describe("archiwum bez konta — km_archive_stats + ranking", () => {
  const hist = (name: string, year: number, km: number, nickname = name) =>
    ({uid: "historical_unmatched", userSnapshot: {displayName: name, nickname}, year, date: `${year}-01-01`, km});

  it("computeArchiveStats: agregacja per nazwa i rok, „c” pominięte, wpisy z kontem pominięte", () => {
    const out = computeArchiveStats([
      hist("Kamila K", 2012, 9), hist("Kamila K", 2012, 1.5), hist("Kamila K", 2013, 4),
      hist("c", 2014, 6.01), hist("Łukasz K", 2015, 17),
      {uid: "u1", userSnapshot: {displayName: "Jan"}, year: 2012, km: 50},
    ]);
    expect(Object.keys(out).sort()).toEqual(["archive_kamila-k", "archive_lukasz-k"]);
    expect(out["archive_kamila-k"]).toMatchObject({
      archive: true, displayName: "Kamila K", allTimeKm: 14.5, allTimeLogs: 3,
      years: {"2012": {km: 10.5, logs: 2, days: 2, hours: 0, points: 0}, "2013": {km: 4, logs: 1, days: 1, hours: 0, points: 0}},
    });
  });

  async function runRankings(db: FakeFirestore, query: any) {
    const out: any = {};
    const res: any = {status(s: number) {
      out.status = s; return res;
    }, json(b: any) {
      out.body = b; return res;
    }};
    let inner: Promise<void> = Promise.resolve();
    await handleKmRankings({method: "GET", query} as any, res, {
      db: db as any, sendPreflight: () => false, requireAllowedHost: () => true, setCorsHeaders: () => undefined,
      corsHandler: (_q: any, _r: any, next: () => Promise<void>) => {
        inner = next();
      },
      requireIdToken: async () => ({decoded: {uid: "u1"}}),
    } as any);
    await inner;
    return out;
  }

  it("task zapisuje km_archive_stats i usuwa nieaktualne; ranking łączy z km_user_stats", async () => {
    const db = new FakeFirestore({
      km_logs: [
        {_docId: "h1", ...hist("Mario", 2012, 100)},
        {_docId: "h2", ...hist("Mario", 2013, 20)},
        {_docId: "h3", ...hist("Waldek", 2012, 30)},
      ],
      km_archive_stats: [{_docId: "archive_stary", uid: "archive_stary", archive: true, allTimeKm: 999}],
      km_user_stats: [
        {_docId: "u1", uid: "u1", nickname: "Jan", allTimeKm: 110, yearKm: 5, years: {"2012": {km: 50}, "2026": {km: 5}}},
        {_docId: "u2", uid: "u2", nickname: "Ola", allTimeKm: 10, yearKm: 0, years: {"2012": {km: 10}}},
      ],
    });
    const ctx: any = {firestore: db, logger: {info: () => undefined, warn: () => undefined, error: () => undefined}};
    const r = await kmRebuildArchiveStatsTask.run({}, ctx);
    expect(r.details).toMatchObject({people: 2, logs: 3, deleted: 1});
    expect((await db.collection("km_archive_stats").get()).docs.map((d) => d.id).sort()).toEqual(["archive_mario", "archive_waldek"]);

    const all = await runRankings(db, {type: "km", period: "alltime"});
    expect(all.body.entries.map((e: any) => [e.rank, e.nickname, e.value, e.archive]))
      .toEqual([[1, "Mario", 120, true], [2, "Jan", 110, false], [3, "Waldek", 30, true], [4, "Ola", 10, false]]);

    const y2012 = await runRankings(db, {type: "km", period: "specificYear", year: "2012"});
    expect(y2012.body.entries.map((e: any) => [e.nickname, e.value])).toEqual([["Mario", 100], ["Jan", 50], ["Waldek", 30], ["Ola", 10]]);

    const limited = await runRankings(db, {type: "km", period: "alltime", limit: "2"});
    expect(limited.body.entries.map((e: any) => e.nickname)).toEqual(["Mario", "Jan"]);

    // Bieżący rok — bez archiwum
    const year = await runRankings(db, {type: "km", period: "year"});
    expect(year.body.entries.map((e: any) => e.nickname)).toEqual(["Jan"]);

    // Godziny — archiwum ma 0, więc nikt z archiwum
    const hours = await runRankings(db, {type: "hours", period: "alltime"});
    expect(hours.body.entries).toEqual([]);
  });
});
