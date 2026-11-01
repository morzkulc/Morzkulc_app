/**
 * Dane na żywo z aplikacji dla strony klubu (morzkulc.pl): liczby, blachowani, basen, akweny.
 * Publiczne wyłącznie: sumy, rejestr Blach (bez e-maili i uzasadnień), daty terminów basenu,
 * nazwy akwenów — żadnych ról poszczególnych osób, zapisów, sald ani sprzętu prywatnego.
 *
 * Wynik trzymany w pamięci instancji (TTL niżej): endpoint publiczny może być odpytywany
 * przez boty, a bez cache każde wywołanie czytałoby kilkaset dokumentów.
 */
import {MEMBER_ROLE_KEYS} from "../users/member_standing";
import {todayWarsawIso} from "../shared/date_range_utils";
import {BLACHY_COLLECTION, sortRegistry, toPublic} from "../blachy/blachy_registry";
import {isSessionCancelled} from "../basen/basen_service";

const TEST = Boolean(process.env.VITEST);
const STATS_TTL_MS = TEST ? 0 : 60 * 60 * 1000; // liczby zmieniają się rzadko
const LIVE_TTL_MS = TEST ? 0 : 15 * 60 * 1000; // = max-age CDN odpowiedzi
const MAX_BASEN_TERMINY = 6;
const MAX_MIEJSCA = 30;

export type PublicKayaks = {gorskie: number; freestyle: number; nizinne: number; morskie: number; kanadyjki: number; razem: number};
export type PublicStats = {czlonkowie: number; kajaki: PublicKayaks; imprezy: {rok: number; liczba: number}};
export type PublicBlacha = {imie: string; ksywa: string; nazwisko: string; rok: number | null; nr: number | null; honorowa: boolean; sp: boolean; klub: string; okazja: string; miejsce: string};
export type PublicBasen = {ruszyl: boolean; terminy: string[]};
export type PublicMiejsce = {nazwa: string; od: number | null; do: number | null};
export type PublicLive = {blachy: PublicBlacha[]; basen: PublicBasen; miejsca: PublicMiejsce[]};

// Kolumna „Typ” arkusza sprzętu → kategoria na stronie. Nieznany typ liczy się tylko do sumy.
function kayakCategory(type: string): keyof Omit<PublicKayaks, "razem"> | null {
  const t = String(type || "").toLowerCase();
  if (t.includes("morsk")) return "morskie";
  if (t.includes("kanad")) return "kanadyjki";
  if (t.includes("freestyle") || t.includes("playboat")) return "freestyle";
  if (t.includes("nizin") || t.includes("zwałk")) return "nizinne";
  if (t.includes("river") || t.includes("creek") || t.includes("gór")) return "gorskie";
  return null;
}

export async function computePublicStats(db: FirebaseFirestore.Firestore, today: string = todayWarsawIso()): Promise<PublicStats> {
  const year = today.slice(0, 4);
  const [usersSnap, kayaksSnap, eventsSnap] = await Promise.all([
    db.collection("users_active").where("role_key", "in", MEMBER_ROLE_KEYS).get(),
    db.collection("gear_kayaks").get(),
    db.collection("events").where("startDate", ">=", `${year}-01-01`).where("startDate", "<=", `${year}-12-31`).get(),
  ]);

  const czlonkowie = usersSnap.docs.filter((d) => (d.data() as any)?.status_key === "status_aktywny").length;

  const kajaki: PublicKayaks = {gorskie: 0, freestyle: 0, nizinne: 0, morskie: 0, kanadyjki: 0, razem: 0};
  for (const d of kayaksSnap.docs) {
    const k = d.data() as any;
    if (k.isPrivate || k.gearScrapped || k.isActive === false) continue;
    kajaki.razem++;
    const cat = kayakCategory(k.type);
    if (cat) kajaki[cat]++;
  }

  const liczba = eventsSnap.docs.filter((d) => {
    const e = d.data() as any;
    return e.approved === true && e.rejected !== true;
  }).length;

  return {czlonkowie, kajaki, imprezy: {rok: Number(year), liczba}};
}

export async function computePublicLive(db: FirebaseFirestore.Firestore, today: string = todayWarsawIso()): Promise<PublicLive> {
  const [blachySnap, appSnap, sessionsSnap, mapSnap] = await Promise.all([
    db.collection(BLACHY_COLLECTION).get(),
    db.collection("setup").doc("app").get(),
    db.collection("basen_sessions").where("date", ">=", today).get(),
    db.collection("km_map_cache").doc("v1").get(),
  ]);

  const blachy = sortRegistry(blachySnap.docs.map((d) => toPublic(d.id, d.data())))
    // Archiwum ma datę nadania zamiast roku — rok z daty.
    .map((b) => ({imie: b.imie, ksywa: b.ksywa, nazwisko: b.nazwisko, rok: b.rok ?? (b.data ? Number(b.data.slice(0, 4)) : null),
      nr: b.nr, honorowa: b.honorowa, sp: b.sp, klub: b.klub, okazja: b.okazja, miejsce: b.miejsce}));

  // Basen „ruszył” = zwykły członek widzi moduł w aplikacji — ta sama reguła co canSeeModule
  // (public/core/access_control.js): tryb test z rolą na liście też udostępnia moduł, także przy enabled:false.
  const app = (appSnap.exists ? (appSnap.data() as any) : null) || {};
  const modul = (app.modules || app).modul_6 || {};
  const mode = String(modul.access?.mode || "prod");
  const roleOk = Array.isArray(modul.access?.rolesAllowed) && modul.access.rolesAllowed.map(String).includes("rola_czlonek");
  const ruszyl = roleOk && mode !== "off" && (modul.enabled === true || mode === "test");
  const terminy = ruszyl ? sessionsSnap.docs
    .map((d) => d.data() as any)
    .filter((s) => !isSessionCancelled(s))
    .map((s) => String(s.date || ""))
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))
    .sort()
    .slice(0, MAX_BASEN_TERMINY) : [];

  const locations: any[] = (mapSnap.exists ? (mapSnap.data() as any)?.locations : null) || [];
  const miejsca = locations
    .filter((l) => String(l?.placeName || "").trim())
    .sort((a, b) => Number(b.logCount || 0) - Number(a.logCount || 0))
    .slice(0, MAX_MIEJSCA)
    .map((l) => {
      const years = (Array.isArray(l.yearsActive) ? l.yearsActive : []).map(Number).filter(Number.isFinite);
      return {nazwa: String(l.placeName).trim(), od: years.length ? Math.min(...years) : null, do: years.length ? Math.max(...years) : null};
    });

  return {blachy, basen: {ruszyl, terminy}, miejsca};
}

function memo<T>(ttl: number, fn: (db: FirebaseFirestore.Firestore) => Promise<T>) {
  let cached: {ts: number; promise: Promise<T>} | null = null;
  return (db: FirebaseFirestore.Firestore): Promise<T> => {
    const now = Date.now();
    if (ttl > 0 && cached && now - cached.ts < ttl) return cached.promise;
    const promise = fn(db).catch((err) => {
      cached = null;
      throw err;
    });
    cached = {ts: now, promise};
    return promise;
  };
}

export const getPublicStats = memo(STATS_TTL_MS, (db) => computePublicStats(db));
export const getPublicLive = memo(LIVE_TTL_MS, (db) => computePublicLive(db));
