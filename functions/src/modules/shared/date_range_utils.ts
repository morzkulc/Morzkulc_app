import {normNullish} from "./text_utils";

export function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** Dzisiejsza data w strefie Europe/Warsaw jako YYYY-MM-DD. */
export function todayWarsawIso(): string {
  return new Date().toLocaleDateString("en-CA", {timeZone: "Europe/Warsaw"});
}

export function isoToDateUTC(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // południe UTC — bezpieczne dla DST
}

export function dateUTCToIso(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

export function minusDays(iso: string, n: number): string {
  const d = isoToDateUTC(iso);
  d.setUTCDate(d.getUTCDate() - n);
  return dateUTCToIso(d);
}

/**
 * Odejmuje n miesięcy kalendarzowych. Dzień przycinany do długości miesiąca docelowego
 * (31.03 − 1 → 28.02, 31.05 − 1 → 30.04) — surowe setUTCMonth przepełniało się do
 * następnego miesiąca (31.03 − 1 = 03.03), skracając zakres raportów uruchamianych
 * 29–31 dnia miesiąca.
 */
export function minusMonths(iso: string, n: number): string {
  const d = isoToDateUTC(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  const daysInTarget = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, daysInTarget));
  return dateUTCToIso(d);
}

export type DateRangeResult =
  | {ok: true; from: string; to: string; key: string}
  | {ok: false; message: string};

export type ResolveDateRangeOpts = {
  /** Klucz zwracany gdy `range` nieznane/puste. */
  defaultKey: "current" | "semester";
  /** Czy "current" (dziś-dziś) jest w ogóle rozpoznawanym kluczem dla tego raportu. */
  supportsCurrent?: boolean;
  /** "days30" (today-30 dni) albo "calendarMonth" (today-1 miesiąc kalendarzowy). Domyślnie "days30". */
  monthMode?: "days30" | "calendarMonth";
};

/**
 * Wspólny resolver zakresu dat [from, to] dla rodziny raportów admina (D2: 4 pliki miały
 * niemal identyczną, ale subtelnie rozjechaną kopię — m.in. dwie różne definicje "miesiąca").
 * Parametryzowany, bo raporty realnie różnią się dostępnością "current" i domyślnym kluczem —
 * to NIE jest przypadkowa duplikacja tylko zamierzona różnica, więc zachowana jawnie przez opts.
 */
export function resolveDateRange(
  range: string,
  fromQ: string,
  toQ: string,
  opts: ResolveDateRangeOpts
): DateRangeResult {
  const today = todayWarsawIso();

  if (opts.supportsCurrent && range === "current") {
    return {ok: true, key: "current", from: today, to: today};
  }

  const monthFrom = opts.monthMode === "calendarMonth" ? minusMonths(today, 1) : minusDays(today, 30);

  switch (range) {
  case "month":
    return {ok: true, key: "month", from: monthFrom, to: today};
  case "year":
    return {ok: true, key: "year", from: minusMonths(today, 12), to: today};
  case "custom": {
    const from = normNullish(fromQ);
    const to = normNullish(toQ);
    if (!isIsoDate(from) || !isIsoDate(to)) {
      return {ok: false, message: "Nieprawidłowy zakres dat (wymagany format YYYY-MM-DD)."};
    }
    if (from > to) return {ok: false, message: "Data „od\" jest późniejsza niż „do\"."};
    return {ok: true, key: "custom", from, to};
  }
  case "semester":
    return {ok: true, key: "semester", from: minusMonths(today, 6), to: today};
  default:
    return opts.defaultKey === "current" ?
      {ok: true, key: "current", from: today, to: today} :
      {ok: true, key: "semester", from: minusMonths(today, 6), to: today};
  }
}
