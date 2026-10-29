/**
 * Finanse basenu — czysta logika (bez Firestore), wspólna dla decyzji o terminie
 * (basen.decideSessions), panelu „Finanse" i widoku sezonu dla członków.
 * Zasady: DOCS/Sessions & TO DOs/28.10_regulamin_basenu.md + 28.10_basen_finanse_analiza.md.
 */

// ─── Czas warszawski ─────────────────────────────────────────────────────────
// Funkcje działają w UTC, a godziny basenu w arkuszu są czasem warszawskim —
// new Date("YYYY-MM-DDTHH:MM") na serwerze przesuwało okno rezygnacji o 1–2 h.

const WARSAW_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Warsaw",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function warsawOffsetMs(ms: number): number {
  const parts = WARSAW_PARTS.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Data + godzina czasu warszawskiego → epoch ms (0 przy złym formacie). */
export function warsawLocalMs(date: string, time: string): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  const t = /^(\d{1,2}):(\d{2})/.exec(String(time || ""));
  if (!d || !t) return 0;
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  const first = guess - warsawOffsetMs(guess);
  // Druga iteracja — poprawne także w dniu zmiany czasu.
  return guess - warsawOffsetMs(first);
}

/** Dzisiejsza data w Warszawie (YYYY-MM-DD). */
export function warsawTodayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {timeZone: "Europe/Warsaw", year: "numeric", month: "2-digit", day: "2-digit"}).format(now);
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ─── Sezon ───────────────────────────────────────────────────────────────────
// Sezon basenowy = listopad–marzec; granica roku rozliczeniowego 1 lipca.

export interface SeasonRange { key: string; start: string; end: string; karnetValidUntil: string }

export function seasonOf(dateIso: string): SeasonRange {
  const year = Number(dateIso.slice(0, 4));
  const month = Number(dateIso.slice(5, 7));
  const startYear = month >= 7 ? year : year - 1;
  return {
    key: `${startYear}/${String((startYear + 1) % 100).padStart(2, "0")}`,
    start: `${startYear}-07-01`,
    end: `${startYear + 1}-06-30`,
    karnetValidUntil: `${startYear + 1}-03-31`,
  };
}

// ─── Wycena wejścia (FIFO) ───────────────────────────────────────────────────

export type BasenProduct = "jednorazowe" | "karnet5" | "karnet10";

export interface LedgerLike {
  id?: string;
  type: string;
  amount: number;
  unitPricePln?: number;
  createdAt?: any;
}

function createdMs(r: LedgerLike): number {
  const c = r.createdAt;
  if (!c) return Number.MAX_SAFE_INTEGER;
  if (typeof c.toMillis === "function") return c.toMillis();
  if (c instanceof Date) return c.getTime();
  const n = new Date(c).getTime();
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Wartość (zł) następnego wejścia użytkownika: wejścia schodzą z partii w kolejności
 * zakupu (FIFO). Partie: admin_add (cena z zakupu) i instructor_reward (0 zł).
 * Zużyte = liczba blokad − liczba zwrotów. Wpisy bez ceny (sprzed cennika) liczone
 * po cenie jednorazowej.
 */
export function nextEntryValuePln(records: LedgerLike[], fallbackUnitPrice: number): number {
  const lots = records
    .filter((r) => (r.type === "admin_add" || r.type === "instructor_reward") && Number(r.amount) > 0)
    .sort((a, b) => createdMs(a) - createdMs(b) || String(a.id || "").localeCompare(String(b.id || "")));
  const blocks = records.filter((r) => r.type === "booking_block").length;
  const refunds = records.filter((r) => r.type === "booking_refund").length;
  let consumed = Math.max(0, blocks - refunds);
  for (const lot of lots) {
    const n = Number(lot.amount);
    if (consumed < n) {
      if (lot.type === "instructor_reward") return 0;
      const p = Number(lot.unitPricePln);
      return Number.isFinite(p) ? p : fallbackUnitPrice;
    }
    consumed -= n;
  }
  return fallbackUnitPrice;
}

// ─── Wynik terminu i reguła uruchomienia ─────────────────────────────────────

export interface FinanceVars {
  koszt_terminu: number;
  max_strata_terminu: number;
  budzet_sezonu: number;
}

export interface EnrollmentLike {
  sessionId: string;
  slot: string;
  type: string;
  status: string;
  chargedGodziny?: boolean;
  cancelledLate?: boolean;
  lateRefunded?: boolean;
  valuePln?: number;
}

/** Czy zapis daje przychód: aktywny płatny albo spóźniona rezygnacja bez zwrotu. */
export function enrollmentIsPaid(e: EnrollmentLike): boolean {
  if (e.type === "instructor" || e.chargedGodziny === false) return false;
  if (e.status === "active") return true;
  return e.status === "cancelled" && e.cancelledLate === true && e.lateRefunded !== true;
}

export interface SessionMoney { entries: number; valuePln: number; costPln: number; resultPln: number }

export function sessionMoney(enrollments: EnrollmentLike[], costPln: number): SessionMoney {
  const paid = enrollments.filter(enrollmentIsPaid);
  const valuePln = round2(paid.reduce((s, e) => s + (Number(e.valuePln) || 0), 0));
  return {entries: paid.length, valuePln, costPln, resultPln: round2(valuePln - costPln)};
}

export type Light = "green" | "yellow" | "red";

/**
 * 🟢 wynik ≥ 0; 🟡 strata ≤ limit terminu i wynik sezonu po niej ≥ −budżet; 🔴 reszta.
 * seasonNetPln = wynik netto sezonu BEZ ocenianego terminu.
 */
export function sessionLight(resultPln: number, seasonNetPln: number, v: FinanceVars): Light {
  if (resultPln >= 0) return "green";
  if (-resultPln <= v.max_strata_terminu && seasonNetPln + resultPln >= -v.budzet_sezonu) return "yellow";
  return "red";
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
