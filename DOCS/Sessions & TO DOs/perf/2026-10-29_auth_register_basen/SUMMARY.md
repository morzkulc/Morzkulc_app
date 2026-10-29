# 29.10.2026: trzy poprawki startu (auth bez iframe, register, basen/sessions)

**Metoda:** `../../23.09_pomiary_wydajnosci_METODA.md`, kanał L (Chrome desktop, konto `rola_zarzad`, cache ciepły, `sessionStorage.clear()` przed każdym przebiegiem).
**Mediany z 7 przebiegów.** Przebiegi z `cold > 0` (zimne starty po deployu) odrzucone.
**Logika bez zmian.** Zmieniona tylko kolejność i równoległość odczytów oraz moment ładowania iframe logowania.

---

## Poprawka 1: Firebase Auth bez proaktywnego iframe (`public/core/firebase_client.js`)

**Fakt (kod SDK 10.12.0):** `getAuth()` na przeglądarkach mobilnych i w Safari (`_shouldInitProactively`) PRZED podaniem stanu logowania ładuje `apis.google.com/js/api.js` → `gapi` → `/__/auth/iframe`. Dzieje się to przy każdym starcie, choć iframe obsługuje wyłącznie samo logowanie.
**Zmiana:** `initializeAuth` z tą samą persystencją co domyślne `getAuth()`. Gdy na urządzeniu jest zapisana sesja, resolver nie jest proaktywny i jest podawany jawnie przy logowaniu i redirect. Bez sesji (ekran logowania, powrót z Google) zachowanie jest jak dotąd.

**Uprząż:** prawdziwy `/core/firebase_client.js` w ukrytym iframe, czas od importu do pierwszego `onAuthStateChanged` z userem. Identyczna przed i po.

| metryka | przed | po | zmiana |
|---|---|---|---|
| stan logowania gotowy, UA iPhone | 425 / 478 / 499 / **543** / 544 / 567 / 609 ms | 303 / 320 / 320 / **331** / 428 / 449 / 468 ms | **−212 ms (−39 %)** |
| żądania przed stanem logowania, UA iPhone | 4 (`api.js`, `gapi`, `iframe`, `lookup`), łańcuchowo | **1** (`lookup`) | −3 |
| stan logowania gotowy, UA desktop (kontrola) | mediana 333 ms | mediana 331 ms | bez zmian (desktop nie ładował iframe) |

Desktop nie odczuje tej poprawki z założenia. Na telefonie każde z 3 usuniętych żądań to dodatkowe opóźnienie sieci i parsowanie JS, więc zysk będzie większy niż w labie. **Rozstrzygnie pomiar z iPhone'a** (`#/home/perf`), porównywalny z przebiegiem 24.09: `ms:redirectWait` ok. 650 ms.

## Poprawka 2: `/api/register`, 3 odczyty równolegle (`registerUserHandler.ts`)

`getSetupApp`, `getGodzinkiVars` i `users_active/{uid}` szły jeden po drugim.

| metryka | przed | po | zmiana |
|---|---|---|---|
| praca serwera `app;dur` | 100 / 123 / 126 / **196** / 241 / 253 / 287 | 95 / 96 / 96 / **97** / 102 / 182 / 202 | **−99 ms (−51 %)** |
| `ms:register` (klient, całe żądanie) | mediana 389 ms | mediana 292 ms | **−97 ms (−25 %)** |

## Poprawka 3: `/api/basen/sessions`, 4 etapy odczytów → 2 (`getBasenSessionsHandler.ts`)

| metryka | przed | po | zmiana |
|---|---|---|---|
| praca serwera `app;dur` | 127 / 151 / 178 / **278** / 283 / 302 / 528 | 87 / 97 / 104 / **115** / 122 / 148 / 182 | **−163 ms (−59 %)** |
| czas żądania (klient) | mediana 473 ms | mediana 316 ms | **−157 ms (−33 %)** |
| żądanie zamykające ekran startowy | basen/sessions w 6/7 przebiegów | basen/sessions w 2/7 | przestało być wąskim gardłem |

Nowy test: `functions/test/basen_sessions_handler.test.ts` (widok członka, 403, finance bez uprawnień). Razem 446/446.

## Ekran startowy łącznie (desktop)

| metryka | przed | po | zmiana |
|---|---|---|---|
| `ms:homeFanout` | mediana 474 ms | mediana 386 ms | −88 ms |
| `ms:home` − `ms:redirectWait` (część po zalogowaniu) | mediana 1 088 ms | mediana 970 ms | **−118 ms (−11 %)** |
| `ms:home` | mediana 1 798 ms | mediana 1 916 ms | **nieporównywalne**, patrz niżej |

**Dlaczego surowe `ms:home` na desktopie nie jest miarą tych poprawek:** w przebiegach z `location.reload()` między końcem `accounts:lookup` a stanem logowania pojawia się przerwa bez żadnego ruchu sieciowego. Trwa losowo 200–850 ms (przed: np. 795 → 1 180 ms; po: 302 / 716 / 848 ms). W świeżej karcie (nawigacja, nie reload) ta sama przerwa to 214 ms. Przerwa dotyczy wersji przed i po, a jej rozrzut (±450 ms) przekracza efekt poprawek 2 i 3. Dlatego każdą poprawkę mierzę jej własną metryką.

## Nowe znalezisko (niezbadane do końca)

**W23: przerwa po `accounts:lookup` przy przeładowaniu strony, 200–850 ms.** Brak ruchu sieciowego i brak długich zadań na wątku głównym (Long Animation Frames: 0). W iframe i w świeżej karcie przerwa jest krótka (65–214 ms). Przyczyna nie jest ustalona. Kandydat do sprawdzenia: zapis sesji Firebase do IndexedDB (`_set` po `lookup`) czekający na połączenie poprzedniej instancji strony. Dotyczy ręcznego odświeżania; otwarcie aplikacji z ikony to nawigacja, nie reload.

## Kierunki na później (zmierzone, nie ruszane)

- **Odznaka zarządu `/api/admin/pending?view=badge`** zamyka teraz ekran startowy dla zarządu/KR: `app` 99–141 ms.
- **`net` ~180–240 ms na każde żądanie API** z Polski (RTT do Cloud Run `us-central1` + proxy Hostingu). Ścieżka startu ma dwa takie etapy jeden po drugim: register → fanout. Region funkcji to decyzja infrastrukturalna; wymaga sprawdzenia lokalizacji Firestore.
- **Narzut Service Workera na `/api/*`:** zmierzony 0–1 ms na desktopie, nie warto ruszać.

## Telefon: pierwszy pomiar po wdrożeniu (iPhone, iOS 18.7, konto zarządu, 29.10 09:36 UTC)

Porównanie z przebiegiem odniesienia 24.09 08:14 (`../2026-09-24_telefon/SUMMARY.md`). Oba przebiegi `coldSum: 0`.

| metryka | 24.09 | 29.10 | zmiana |
|---|---|---|---|
| `/api/basen/sessions` (całe żądanie / `app`) | 806 / 461 ms | **401 / 160 ms** | **−405 ms (−50 %)** |
| `/api/register` (całe żądanie) | 433 ms | **335 ms** (`app` 95) | **−98 ms (−23 %)** |
| `ms:homeFanout` | 1 477 ms | **405 ms** | −1 072 ms (odznaka z cache + basen) |
| `net` na żądanie | 255–293 ms | 232–248 ms | — |
| `js0` (przed pierwszym JS) | 184 ms | **1 372 ms** | artefakt, patrz niżej |
| `ms:redirectWait` | ~650 ms | 1 386 ms | **nierozstrzygnięte**, patrz niżej |
| `ms:home` | 3 105 ms | 3 505 ms | nieporównywalne |

**Poprawki 2 i 3 potwierdzone na telefonie.** To zmiany po stronie serwera, więc nie zależą od tego, którą wersję frontendu miał telefon. `/api/basen/sessions` zamykało ekran startowy także tutaj, a fanout skończył się 4 ms po nim.

**Poprawka 1 nierozstrzygnięta.** Dwa przebiegi (09:36:05 i 09:36:10) były pierwszymi otwarciami po deployu, 5 s jeden po drugim:
- Service Worker w tym momencie podmieniał cache. Z danych nie da się ustalić, czy działał już nowy `firebase_client.js`.
- `js0` 1 372 ms (24.09: 184 ms) to pobieranie zasobów z sieci po wyczyszczeniu starego cache.
- Odstęp 5 s wskazuje na przeładowanie, a przy przeładowaniu działa W23.

**Wymagany pomiar:** aplikację zamknąć całkowicie (wysunąć z przełącznika aplikacji), otworzyć z ikony, Profil → Pomiary startu → Kopiuj JSON. Powtórzyć 3 razy, z odstępem co najmniej 2 minut.

### Znalezisko z historii telefonu: zimne starty
W 10 ostatnich przebiegach na tym urządzeniu 5 miało `coldSum` > 0: 3 525, 17 166, 17 727, 17 936, 18 072 ms. `ms:home` w tych przebiegach wynosiło od 6 272 do 49 580 ms. Przebiegi bez zimnego startu: 2 356–3 505 ms. **Zimne instancje Cloud Run są dominującym źródłem „wolnej apki” w realnym użyciu.** Środek zaradczy, czyli `minInstances` dla funkcji ścieżki startowej, kosztuje i wymaga decyzji.
