/**
 * Cache dokumentów konfiguracyjnych w pamięci instancji Cloud Functions.
 *
 * Problem: dokumenty `setup/*` (vars_gear, vars_godzinki, vars_basen, vars_kurs,
 * vars_members, app) były czytane z Firestore przy KAŻDYM żądaniu, a niektóre
 * po kilka razy w jednym żądaniu (vars_kurs trzykrotnie przy tworzeniu rezerwacji).
 * To dokumenty konfiguracyjne, zmieniane wyłącznie ręcznym syncem z arkusza SETUP
 * — praktycznie niezmienne w skali minut.
 *
 * ŚWIADOMA ZMIANA ZACHOWANIA (zaakceptowana 23.09.2026): po zmianie zmiennej
 * w arkuszu i uruchomieniu syncu, ciepłe instancje zobaczą nową wartość
 * z opóźnieniem do TTL (60 s). Zimny start i nowe instancje mają cache pusty.
 *
 * Cache żyje wyłącznie w pamięci instancji — nie ma współdzielenia między
 * instancjami ani trwałości między wdrożeniami.
 */

// Pod testami cache jest wyłączony (TTL 0 → każdy odczyt trafia do bazy).
// Testy zapisują własną konfigurację i czytają ją natychmiast, więc trzymanie
// wyniku sprzed sekundy fałszowałoby wynik. Produkcja działa z pełnym TTL.
const DEFAULT_TTL_MS = process.env.VITEST ? 0 : 60 * 1000;

type Entry = {ts: number; promise: Promise<FirebaseFirestore.DocumentSnapshot>};

const cache = new Map<string, Entry>();

/**
 * Zwraca snapshot dokumentu, korzystając z cache instancji.
 * Trzymamy obietnicę, nie wynik — równoległe wywołania w jednym żądaniu
 * (np. trzy odczyty vars_kurs) współdzielą jeden odczyt zamiast się ścigać.
 */
export async function getCachedDoc(
  db: FirebaseFirestore.Firestore,
  collection: string,
  docId: string,
  ttlMs: number = DEFAULT_TTL_MS
): Promise<FirebaseFirestore.DocumentSnapshot> {
  const key = `${collection}/${docId}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (ttlMs > 0 && hit && now - hit.ts < ttlMs) return hit.promise;

  const promise = db.collection(collection).doc(docId).get().catch((err) => {
    // Porażki nie utrwalamy — kolejne żądanie ma prawo spróbować ponownie.
    cache.delete(key);
    throw err;
  });
  cache.set(key, {ts: now, promise});
  return promise;
}

/** Czyści cache — używane w testach. */
export function clearDocCache(): void {
  cache.clear();
}
