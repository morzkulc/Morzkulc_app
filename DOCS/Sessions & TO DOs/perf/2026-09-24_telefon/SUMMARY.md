# Pomiar z telefonu — 24.09.2026

**Urządzenie:** iPhone, iOS 18.7, Safari 26.6.1, 4 rdzenie, Service Worker aktywny.
**Konto:** `rola_zarzad` — **najcięższy możliwy wariant ekranu startowego** (dochodzi `/api/admin/pending`).
**Źródło:** `#/home/perf` → „Kopiuj JSON", przebieg 2026-09-24T08:14:17Z + historia 10 przebiegów.

---

## 1. Wniosek najważniejszy

**Na telefonie główne KPI się nie poprawiło.** Dwa czyste przebiegi (oba `coldSum: 0`):

| metryka | 2026-09-23T12:18Z (przed optymalizacjami) | 2026-09-24T08:14Z (po etapach 1–4) | zmiana |
|---|---|---|---|
| **`ms:home`** | **3 097 ms** | **3 105 ms** | **0 %** |
| `ms:boot` (do szkieletu) | 2 633 ms | 1 630 ms | **−38 %** |
| `ms:jsGraph` (parse+compile JS) | 734 ms | 352 ms | **−52 %** |
| `ms:homeFanout` | 467 ms | 1 477 ms | **+216 %** |
| wywołań API | 7 | 8 | +1 |

Oba przebiegi są sprzed/po wdrożeniach: instrumentacja weszła ok. 12:0x UTC 23.09, Etap 1 dopiero ok. 16:3x UTC — przebieg 12:18 jest więc sprzed optymalizacji.

## 2. Dlaczego zysk zniknął

Różnica między przebiegami to **dokładnie jedno żądanie**: `/api/admin/pending`.

```
/api/admin/pending   ttfb 1469 ms   app 385 ms   cold 0   net 1089 ms
/api/basen/sessions  ttfb  806 ms   app 461 ms   cold 0   net  345 ms
pozostałe sześć      ttfb 255–293 ms
```

W przebiegu 12:18 odznaka panelu Zarządu została podana z `sessionStorage`
(`_ADMIN_BADGE_CACHE_KEY`), więc żądania w ogóle nie było — stąd 7 wywołań zamiast 8
i fanout 467 ms. W przebiegu 08:14 cache był pusty i ekran startowy czekał na nie
1 474 ms. `ms:homeFanout` ≈ czas tego jednego żądania.

**To nie jest regresja po zmianach** — to inny zestaw pracy w obu przebiegach.
Ale pokazuje, że ścieżkę startu zdominowało coś, czego etapy 1–4 nie dotykały.

## 3. Co działa zgodnie z planem (potwierdzone na telefonie)

| metryka | wartość | pozycja |
|---|---|---|
| `ms:tokenWait` | **0 ms** | W7 — wymuszone odświeżenie tokenu usunięte |
| `ms:setup` | **0 ms** | W8 — `setup` rozwiązany zanim skończył się `register` |
| `boot;dur` z nagłówków | **997–1 782 ms** (było 4 032) | W1a+W1b |
| `ms:jsGraph` | 352 ms (było 734) | W2 — moduły nie ładują się na starcie |
| `fcp` | 260 ms | — |
| duplikaty żądań | brak | W22 |

Rozkład 3 105 ms: 184 ms do pierwszego modułu → 352 ms graf JS → ~650 ms SDK Firebase
z gstatic → 433 ms `register` (setup równolegle) → 9 ms budowa ekranu → **1 477 ms fanout**.

## 4. Skala problemu dla reszty klubu

Zwykły członek **nie ma** wywołania `/api/admin/pending`. U niego bramkę zamyka
`/api/basen/sessions` (806 ms), więc ekran gotowy wypada ok. **2 440 ms** zamiast 3 105.
Zmierzony wariant dotyczy wyłącznie zarządu i KR.

## 5. Proponowany następny krok (poza uzgodnionymi etapami 1–4)

`/api/admin/pending` zwraca komplet danych panelu Zarządu (wszystkie sekcje, zaległości,
ujemne salda, raport syncu), a ekranowi startowemu potrzebna jest z tego **jedna liczba**.

**Propozycja:** `?view=badge` liczące wyłącznie `godzinki.count`. Oczekiwany efekt:
`app` z 385 ms do kilkunastu, `ms:home` na tym telefonie w okolicach 2 400–2 600 ms (−20 %).

**Odrzucone:** wyjęcie odznaki z bramki „ekran gotowy". Poprawiłoby wskaźnik, nie aplikację.

## 6. Historia przebiegów z tego urządzenia

| kiedy (UTC) | `ms:home` | `jsGraph` | `fanout` | `coldSum` | uwaga |
|---|---|---|---|---|---|
| 09-23 12:18 | 3 097 | 734 | 467 | 0 | **przed optymalizacjami**, odznaka z cache |
| 09-23 12:51 | 4 360 | 593 | 725 | 0 | przed optymalizacjami |
| 09-23 17:22 | 4 025 | 894 | 3 | 41 573 | tuż po deployu |
| 09-23 17:23 | 4 548 | 210 | 2 725 | 157 044 | tuż po deployu |
| 09-23 17:42 | 3 435 | 306 | 1 101 | 0 | |
| 09-23 18:58 | 9 770 | 228 | 4 842 | 17 360 | zimne starty |
| 09-23 19:33 | 8 976 | 208 | 3 856 | 14 791 | zimne starty |
| 09-24 05:58 | 9 979 | 136 | 4 066 | 14 339 | zimne starty |
| 09-24 08:13 | 4 604 | 101 | 1 651 | 0 | przebieg niepełny (2 wywołania) |
| **09-24 08:14** | **3 105** | **352** | **1 477** | **0** | **przebieg odniesienia** |

Przebiegi z `coldSum` rzędu kilkunastu sekund to pierwsze wejścia po wdrożeniach —
artefakt deployu, nie ruch użytkowy. Odrzucone z porównań.
