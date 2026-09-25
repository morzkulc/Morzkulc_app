/**
 * Pomiar kosztu ładowania grafu modułów funkcji (entrypoint lib/index.js).
 *
 * Po co osobny plik: importy w CommonJS wykonują się w kolejności źródłowej, więc
 * żeby zmierzyć koszt WŁASNYCH `require` z index.ts, trzeba zapisać znacznik
 * ZANIM którykolwiek z nich się wykona. Ten moduł musi więc być PIERWSZYM
 * importem w index.ts, a markModuleEvalDone() — ostatnią instrukcją pliku.
 *
 * Dlaczego to, a nie process.uptime() przy pierwszym żądaniu: uptime mierzy wiek
 * instancji, który zawiera też czas bezczynności między startem kontenera a
 * pierwszym żądaniem (przy deployu potrafi to być kilkadziesiąt sekund — zmierzone
 * 32,5 s zaraz po wdrożeniu 23.09.2026). Do oceny zmian typu „przestań ładować
 * googleapis w każdej funkcji" potrzebna jest liczba odporna na ten artefakt.
 */

/** Uptime procesu w chwili, gdy index.ts zaczął ładować swoje zależności. */
export const FRAMEWORK_BOOT_MS = Math.round(process.uptime() * 1000);

let moduleEvalMs = -1;

/** Wołane jako ostatnia instrukcja index.ts. */
export function markModuleEvalDone(): void {
  if (moduleEvalMs >= 0) return;
  moduleEvalMs = Math.round(process.uptime() * 1000) - FRAMEWORK_BOOT_MS;
}

/** Koszt załadowania grafu modułów index.ts w ms (-1 dopóki nie zakończone). */
export function getModuleEvalMs(): number {
  return moduleEvalMs;
}
