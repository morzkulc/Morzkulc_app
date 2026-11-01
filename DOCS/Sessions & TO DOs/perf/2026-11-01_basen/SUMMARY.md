# Wydajność modułu Basen — 01.11.2026

Kanał L (Chrome, desktop, konto zarządu, prod `morzkulc-e9df7`) + analiza kodu. Baza basenu **pusta** (po resecie) — pomiar na żywo pokazuje koszt stały, skalę liczy analiza kodu.

## 1. Pomiar na żywo (7 wywołań na endpoint, mediana ciepłych)

| Endpoint | Czas żądania | `app;dur` | Pierwsze (zimne) |
|---|---|---|---|
| `GET /api/basen/sessions` | 315 ms | 94 ms | — (ciepłe) |
| `GET /api/basen/sessions?view=finance` | 339 ms | 55 ms | — |
| `GET /api/basen/godziny/my` | 384 ms | 165 ms | — |
| `GET /api/basen/admin/godziny/users` | 329 ms | 112 ms | **3641 ms** (cold 1968, boot 1459, app 997) |
| `GET /api/basen/admin/godziny/users?scope=all` | 342 ms | 104 ms | — (14 KB) |
| `GET /api/basen/kayaks` | 303 ms | 93 ms | — |
| `GET /api/basen/admin/godziny/history` | 307 ms | 102 ms | **3930 ms** (cold 2334, boot 1586, app 1027) |

Logi prod (30.10, realne użycie): zimny start `getBasenSessions` — `bootMs` 5031 i 2142.

**Wniosek:** ciepło wszystko ~300 ms. Spowalniają **zimne starty: 3,6–5,8 s** na pierwsze kliknięcie danej akcji (każda akcja basenu = osobna Cloud Function, bez minInstances).

## 2. Co rośnie z danymi (analiza kodu)

Założenie końca sezonu: 40 terminów × ~16 zapisów ≈ 750 zapisów, ≈ 1000 wpisów salda, ≈ 600 przydziałów kajaków.

| # | Miejsce | Problem | Odczyty na 1 otwarcie modułu (koniec sezonu) |
|---|---|---|---|
| **W1** | `getAvailableKayaksBySessionSlot` | `basen_kayak_allocations` czytane **w całości**, bez filtra daty — przydziały minionych terminów nie są kasowane, rośnie **bez końca, także w kolejnych sezonach** | ~600 i rośnie |
| **W2** | `loadSeasonEnrollments` | wszystkie zapisy sezonu przy każdym otwarciu (do paska sezonu / statusów) | ~750 |
| W3 | `getUserEnrollments` | wszystkie aktywne zapisy usera od zawsze (potrzebne tylko nadchodzące) | ~20–40 |
| W4 | `getWaitlistsBySessionSlot` | wpisy `waiting` minionych terminów nigdy nie zmieniają statusu, filtr daty w pamięci | rośnie powoli |
| W5 | modal „Edytuj zapis” | kajaki pobierane osobnym zapytaniem do osobnej funkcji (`/api/basen/kayaks`) → zimny start jak przy dawnej liście instruktorów | 1 zimny start |
| W6 | `/api/basen/admin/godziny/users` | cały `basen_godziny_ledger` (cała historia) — tylko panel obsługi | ~1000 i rośnie |

**`/api/basen/sessions` pod koniec sezonu: ~1500 odczytów Firestore na jedno otwarcie** (dziś: kilkanaście). Darmowy limit: 50 000 odczytów/dzień → **~33 otwarcia modułu dziennie** wyczerpią limit (koszty, wbrew zasadzie darmowej strefy). Czas: wzrost `app;dur` z ~100 ms do kilkuset ms (nie zmierzone — baza pusta).

## 3. Propozycje

| # | Zmiana | Efekt | Ryzyko / koszt |
|---|---|---|---|
| P1 (W1) | przydziały tylko `sessionId >= dziś` | ~600 → kilkadziesiąt odczytów | małe; indeks jednopolowy automatyczny |
| P2 (W2) | wynik minionego terminu zapisywany na terminie (przy decyzji / po dacie); czytane zapisy tylko terminów nierozliczonych | ~750 → ~60 | średnie; zmiana `computeSeason` + backfill zbędny (baza pusta) |
| P3 (W3+W4) | filtr daty w zapytaniu | mniejsze | indeksy złożone — zbudować PRZED kodem |
| P4 (W5) | „Edytuj zapis”: kajaki z danych terminu (jak instruktorzy) | −1 zimny start | małe |
| P5 | wszystkie endpointy basenu w **jednej** Cloud Function | jeden zimny start na sesję zamiast na każdą akcję (3,6–5,8 s → raz) | duże: nowa funkcja (ręcznie public invoker), przepięcie rewrite'ów, usunięcie 16 starych |
| P6 (W6) | saldo basenowe trzymane zbiorczo | panel obsługi | średnie; niski priorytet |

## 4. Wdrożone 01.11.2026 (prod)

| # | Stan | Weryfikacja |
|---|---|---|
| P1 | przydziały `where sessionId >= dziś` | sessions 200 |
| P2 | `session.final` zapisywany w `basen.grantInstructorRewards` (03:45) przez `finalizePastSessions`; `loadSeasonEnrollments` czyta tylko terminy bez `final` | test `basen_finance.test.ts`: wynik sezonu identyczny |
| P3 | indeksy `basen_enrollments(userUid,status,sessionId)`, `basen_waitlist(status,sessionId)` zbudowane przed kodem | sessions 200 |
| P4 | „Edytuj zapis” bierze kajaki z `slot.availableKayaks`; `getBasenKayaks` usunięta | — (baza pusta) |
| P5 | jedna funkcja `basenApi` (15 ścieżek, routing po `req.path`), rewrite'y przepięte, 14 starych funkcji usuniętych | 5 GET → 200, 11 POST → walidacja handlera (400), wszystkie z jednej instancji (ten sam `boot`) |

Po P5, ciepło: 326–446 ms na żądanie, `app` 100–211 ms. Zimny start: jeden na otwarcie modułu (pierwsze `sessions`: 1735 ms, `boot` 1831 ms), potem każda akcja trafia w ciepłą instancję.

Zostaje: P6 (panel obsługi, niski priorytet).
