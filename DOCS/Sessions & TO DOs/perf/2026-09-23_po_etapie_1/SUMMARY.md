# Po Etapie 1 — 23.09.2026

**Porównanie z:** `../baseline_2026-09-23/SUMMARY.md`
**Metoda:** `../../23.09_pomiary_wydajnosci_METODA.md` (identyczna procedura, to samo urządzenie i konto)

---

## 1. Główne KPI

| scenariusz | przed | po | zmiana |
|---|---|---|---|
| **cache ciepły, backend ciepły** (mediana z 4) | **3 204 ms** | **2 281 ms** | **−923 ms (−29 %)** |
| przebiegi | 3233 / 2903 / 3175 / 3259 | 2314 / 2283 / 2278 / 2204 | rozrzut zmalał z 356 do 110 ms |

## 2. Backend — koszt zimnego startu

| metryka | przed | po | zmiana |
|---|---|---|---|
| `boot;dur` (ładowanie grafu modułów na Cloud Run) | **4 032 ms** | **1 218 ms** (mediana z 7: 955–1619) | **−70 %** |
| lokalnie: `moduleEvalMs` | 1 207 ms | **427–486 ms** | −60 % |
| lokalnie: modułów w `require.cache` | 1 739 | **721** | −1 018 |
| `googleapis` w ścieżce zwykłego endpointu | tak | **0 modułów** | wyeliminowane |

Discovery przy deployu nadal ładuje komplet (1 739 modułów, 81 eksportów, żaden nie znika) — bramka `FUNCTION_TARGET` działa tylko w runtime.

## 3. Pozycje potwierdzone pojedynczo

| poz. | dowód | przed | po |
|---|---|---|---|
| **W1a+W1b** | `boot;dur` z nagłówka Server-Timing | 4 032 ms | 1 218 ms |
| **W22** (nowa) | lista duplikatów w tabeli API | 6 par duplikatów | **brak** |
| **W7** | liczba żądań do `securetoken.googleapis.com` | 1 | **0** (`ms:tokenWait` 199–1010 → **0**) |
| **W9b** | obecność `firebase-storage.js` w zasobach ekranu startowego | ładowany | **0 żądań** |
| **W13** | `app` przy `/api/register` (próbki `cold==0`) | 277 ms | 539 ms → *patrz uwaga niżej* |
| **W14** | liczba zapytań w `?view=full` | 2 (nakładające się) | 1 |
| **W15 / W20a** | `app` przy `/api/basen/sessions` | 463 ms | do domierzenia na ciepło |
| **W15b** | `app` przy `/api/admin/pending` | 627 ms | do domierzenia na ciepło |
| **W21** | wolumen logów | — | log usunięty (efekt w ms poniżej progu — zgodnie z zapowiedzią) |
| **W9** | `dns/tcp/tls` do gstatic | `ms:redirectWait` 707–1531 | 972 — **w szumie**, zgodnie z zastrzeżeniem z metody |

**Uwaga do W13:** pojedyncza próbka `ms:register` po zmianie (539 ms) jest wyższa niż przed (456–525 ms). To **nie jest** dowód regresji — `/api/register` to pierwsze żądanie po starcie, więc najczęściej trafia w zimną instancję i pomiar jest zdominowany przez `cold`. Rzetelne porównanie wymaga wielu próbek z `cold == 0`; przy obecnym N tej pozycji **nie należy raportować jako potwierdzonej**.

## 4. Liczba żądań ekranu startowego

| | przed | po |
|---|---|---|
| wywołania API do zamknięcia bramki | 7–11 | 7 |
| wywołania API łącznie w przebiegu | **12–14** | **7** |

Spadek wynika z W22: backend wykonuje o połowę mniej pracy przy każdym otwarciu aplikacji, w tym drugi raz `/api/admin/pending` (627 ms) i `/api/basen/sessions` (463 ms).

## 5. Czego ten pomiar nie obejmuje

- **Telefonu.** `ms:jsGraph` na desktopie z ciepłym cache to 26–43 ms; realny koszt parsowania 569 KB JS ujawni się dopiero na telefonie (Etap 3 / W2). Pomiar do wykonania przez użytkownika: `#/home/perf`.
- **Statystyki zimnych startów z produkcji.** Przebiegi tuż po deployu (`cold` 12–15 s) są artefaktem wdrożenia, nie ruchem użytkowym — odrzucone z median.
