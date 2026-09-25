# Wydajność — porównanie etapów

**Punkt odniesienia:** 23.09.2026, przed jakąkolwiek optymalizacją (`baseline_2026-09-23/`)
**Metoda i definicje metryk:** `../23.09_pomiary_wydajnosci_METODA.md`
**Środowisko pomiaru:** desktop, Chrome, konto `rola_zarzad` (najcięższy wariant ekranu startowego)

---

## 1. Główne KPI — `ms:home` (od otwarcia aplikacji do kompletnego ekranu startowego)

| stan | przebiegi (cache ciepły, backend ciepły) | mediana | wobec punktu odniesienia |
|---|---|---|---|
| **punkt odniesienia** | 3233 / 2903 / 3175 / 3259 | **3 204 ms** | — |
| **po Etapie 1** | 2314 / 2283 / 2278 / 2204 | **2 281 ms** | **−923 ms (−29 %)** |
| **po Etapie 3** | 2252 / 2457 / 3343 | ~2 457 ms | bez zmian wobec Etapu 1 (w szumie) |

**Etap 3 celowo nie poprawia tej liczby na desktopie** i było to zapowiedziane w metodzie: przy ciepłym cache `ms:jsGraph` wynosił tam już tylko 26–43 ms, więc usunięcie 430 KB modułów nie ma czego skrócić. Zysk Etapu 3 jest mierzalny gdzie indziej (§ 3) i ujawni się na telefonie, gdzie kosztem jest parsowanie JS przez CPU, a nie transfer.

## 2. Backend — zimny start

| metryka | przed | po | zmiana |
|---|---|---|---|
| `boot;dur` — ładowanie grafu modułów na Cloud Run | **4 032 ms** | **1 218 ms** (mediana z 7; 955–1619) | **−70 %** |
| pełny zimny start endpointu (`cold;dur`) | 6 636 ms | ~3 800 ms (szacunek: 1 218 + ~2 600 stałej części) | −43 % |
| lokalnie: `moduleEvalMs` | 1 207 ms | **427–486 ms** | −60 % |
| lokalnie: modułów w `require.cache` | 1 739 | **721** | −1 018 |
| `googleapis` w ścieżce zwykłego endpointu | ładowany | **0 modułów** | wyeliminowany |
| praca handlera na ciepło (`app;dur`) | 0,3–6 ms | bez zmian | logika nigdy nie była problemem |

Discovery przy deployu nadal widzi komplet 81 eksportów — bramka `FUNCTION_TARGET` działa tylko w runtime.

## 3. Ekran startowy — co się dzieje w sieci

| metryka | przed | po | zmiana |
|---|---|---|---|
| wywołania API przy jednym otwarciu | **12–14** | **7** | **−~45 %** |
| bajty modułów JS pobrane na ekranie startowym | ~430 KB (11 modułów) | **0 B** | wyeliminowane |
| żądania do `securetoken.googleapis.com` | 1 (199–1010 ms) | **0** | wyeliminowane |
| SDK Storage na ekranie startowym | ładowany zawsze | **nie ładowany** | wyeliminowany |
| `ms:jsGraph` przy zimnym cache | 1 245 ms | **436 ms** | **−65 %** |
| arkusze CSS blokujące pierwsze malowanie | 9 (108 KB) | 5 (~54 KB) | −50 % |
| precache Service Workera po deployu | 804 KB + brak `304` (`no-store`) | rdzeń bez modułów, `no-cache` dopuszcza `304` | — |

## 4. Moduł Sprzęt — szukajka

| metryka | przed | po |
|---|---|---|
| żądania do Firebase Storage po wpisaniu 6 znaków | jedna fala na każdy znak (pełny render siatki = **105 żądań**) | **0** |
| pełny render siatki 55 kajaków | 105 żądań | 105 przy pierwszym wejściu, potem z cache |

Zmierzone bezpośrednio: `performance.getEntriesByType("resource")` filtrowane po `firebasestorage`, przed i po wpisaniu „diesel" — różnica **0**.

## 5. Pozycje wdrożone, których NIE potwierdzam pomiarem

Zgodnie z zapowiedzią w metodzie — lepiej powiedzieć „nie wiem" niż sprzedać szum:

| poz. | co zrobiono | dlaczego bez potwierdzenia |
|---|---|---|
| **W21** | usunięty diagnostyczny `logger.info` z każdej operacji zapisu | efekt w ms poniżej progu pomiaru; realny zysk to koszt logów i PII |
| **W11b** | `observer.disconnect()` w dwóch modułach | poprawka poprawnościowa (wyciek), brak sensownej metryki |
| **W13** | `Promise.all` w `registerUser` | `/api/register` to pierwsze żądanie po starcie, więc pomiar dominuje `cold`; przy obecnym N nie da się wydzielić efektu |
| **W9** | `preconnect` do gstatic/securetoken | `ms:redirectWait` 707–1531 → 972 ms; mieści się w szumie |
| **W14** | jedno zapytanie zamiast dwóch w `?view=full` | nie dotyczy ekranu startowego (home woła `?view=home`) |
| **W15 / W15b / W20a** | `getAll` zamiast N odczytów, zrównoleglone sekcje panelu | wymaga serii próbek z `cold == 0` na tych endpointach |
| **W10 / W12 / W19 / W20b** | cache konfiguracji, znacznik sondowania BO, celowane odczyty sprzętu, cache katalogu basenowego | redukują liczbę odczytów Firestore, nie czas na ekranie startowym; efekt rośnie z wielkością kolekcji |

## 6. Pozycja niewdrożona

**W6** — dolna granica daty w skanach `gear_reservations` (`where("blockEndIso", ">=", ...)`).
Wymaga nowego indeksu złożonego `status + blockEndIso + blockStartIso`, a kod nie może wejść zanim indeks się nie zbuduje (zapytania bez gotowego indeksu kończą się błędem). Przy obecnych danych — setki rezerwacji — pozycja nie daje mierzalnego efektu; to zabezpieczenie na 3–5 sezonów naprzód. Do zrobienia osobno, w kolejności: wdroż indeks → poczekaj na zbudowanie → wdroż kod.

## 7. Telefon — POMIAR WYKONANY 24.09, wynik niewygodny

Pełne dane: `2026-09-24_telefon/SUMMARY.md`. Skrót:

| metryka (iPhone, konto zarządu) | przed | po | zmiana |
|---|---|---|---|
| **`ms:home`** | 3 097 ms | 3 105 ms | **bez zmian** |
| `ms:boot` | 2 633 ms | 1 630 ms | −38 % |
| `ms:jsGraph` | 734 ms | 352 ms | −52 % |
| `ms:homeFanout` | 467 ms | 1 477 ms | +216 % |

Wszystkie optymalizowane składniki przyspieszyły. Zysk zjadło **jedno żądanie poza
zakresem etapów 1–4**: `/api/admin/pending` (odznaka panelu Zarządu) trwało 1 474 ms
i samo wyznaczyło moment „ekran gotowy". W przebiegu sprzed zmian odznaka poszła
z `sessionStorage`, więc żądania nie było — stąd pozorny brak poprawy.

Zwykły członek nie ma tego wywołania; u niego bramkę zamyka `/api/basen/sessions`
(806 ms), czyli ekran gotowy ok. 2 440 ms.

**Następny krok do decyzji:** `?view=badge` w `/api/admin/pending`, liczące wyłącznie
`godzinki.count` zamiast kompletu danych panelu.

## 8. Czego ten pomiar nadal nie obejmuje

**Telefonu.** Wszystkie liczby powyżej pochodzą z desktopu. Skarga dotyczy telefonu, a największa zmiana Etapu 3 (zero bajtów modułów, −65 % czasu parsowania JS) ujawnia się właśnie tam, gdzie CPU jest wolne. Pomiar wykonuje użytkownik: otworzyć aplikację na telefonie i wejść na **`#/home/perf`** — ekran pokazuje `ms:home`, rozbicie na etapy i tabelę wywołań API z podziałem `app` / `cold` / `net`, plus historię 10 ostatnich uruchomień na tym urządzeniu.

## 9. `?view=badge` — 24.09, po pomiarze z telefonu

Odznaka panelu Zarządu na ekranie startowym wołała pełny endpoint panelu
(10 zapytań w 7 kolekcjach, w tym pełny odczyt `godzinki_ledger`), żeby wyświetlić
jedną liczbę. Nowy tryb `?view=badge` wykonuje 3 indeksowane zapytania
(godzinki earn + purchase, imprezy), z `.select("rejected")`, i zwraca `{pending: bool}`.

**Test A/B — trzy pary żądań jedno po drugim, to samo połączenie i sesja:**

| pomiar | pełna odpowiedź | tryb badge | zmiana |
|---|---|---|---|
| praca serwera `app` (mediana) | 253 ms | **88 ms** | **−65 %** |
| czas całkowity (mediana) | 439 ms | **281 ms** | −36 % |
| rozmiar odpowiedzi | 3 143 B | **27 B** | −99 % |

Wartości surowe `app`: pełna 363/253/217, badge 94/88/63.

**`ms:home` na desktopie NIE drgnęło:** 2 229 / 2 260 / 2 823 / 2 825 ms
(mediana ~2 542, jeden odrzucony odstający przebieg 4 910). To mieści się w paśmie
wcześniejszych pomiarów (Etap 1: 2 281, Etap 3: ~2 457) — na desktopie rozrzut
między przebiegami (±600 ms) jest większy niż efekt tej zmiany. Na desktopie ten
endpoint nigdy nie był wąskim gardłem: `net` wynosił tam ~200 ms, podczas gdy
na telefonie 1 089 ms.

**Rozstrzygnie pomiar z telefonu** — tam to żądanie trwało 1 474 ms i samo
wyznaczało moment „ekran gotowy".

**Przy okazji naprawione:** odznaka liczyła dotąd wyłącznie godzinki — oczekująca
impreza jej nie zapalała. Teraz obejmuje jedno i drugie. Odznaka nie pokazuje już
liczby, tylko kropkę (decyzja użytkownika: ma sygnalizować, że jest co kliknąć).
