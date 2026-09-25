# Punkt odniesienia — 23.09.2026

**Stan kodu:** `master` + zadanie A + przyrządy pomiarowe (B0/B1). **Żadna optymalizacja wydajnościowa nie jest jeszcze wdrożona.**
**Metoda:** `../../23.09_pomiary_wydajnosci_METODA.md`
**Urządzenie:** desktop, Chrome, konto `rola_zarzad` (najcięższy wariant ekranu startowego — dochodzi `/api/admin/pending`).

---

## 1. Główne KPI — `ms:home` (od otwarcia do kompletnego ekranu startowego)

| przebieg | `ms:home` | `jsGraph` | `fanout` | `cold` (suma) | uwaga |
|---|---|---|---|---|---|
| 12:02:42 | 3 917 | 1 245 | 814 | 0 | cache zimny (po wyczyszczeniu SW) |
| 12:03:39 | **9 930** | 1 092 | 6 162 | **4 730** | trafił w zimne starty backendu |
| 12:04:02 | 3 233 | 25 | 484 | 0 | cache ciepły |
| 12:04:31 | 2 903 | 42 | 506 | 0 | cache ciepły |
| 12:04:46 | 3 175 | 60 | 473 | 0 | cache ciepły |
| 12:04:51 | 3 259 | 34 | 383 | 0 | cache ciepły |

**Wnioski liczbowe:**

| scenariusz | mediana | min | max | N |
|---|---|---|---|---|
| cache ciepły, backend ciepły | **3 204 ms** | 2 903 | 3 259 | 4 |
| cache zimny, backend ciepły | 3 917 ms | — | — | 1 |
| backend zimny | **9 930 ms** | — | — | 1 |

Rozrzut 2,9 s → 9,9 s przy identycznej akcji. **Zmienną, która o tym decyduje, jest wyłącznie to, czy trafimy w zimną instancję Cloud Run.**

## 2. Rozbicie startu (mediana z przebiegów z ciepłym cache)

| etap | ms | pozycja audytu |
|---|---|---|
| do pierwszego modułu JS (`js0`) | ~695 | — |
| pobranie + parsowanie grafu JS (`ms:jsGraph`) | 25–60 ciepły / **1 092–1 245 zimny** | **W2** |
| Firebase SDK z gstatic (`ms:redirectWait`) | 707–1 531 | W9 |
| wymuszone odświeżenie tokenu (`ms:tokenWait`) | **199 / 987 / 1 010** | **W7** |
| `/api/register` (`ms:register`) | 456–525 | W13 |
| `/api/setup` (`ms:setup`) | 232–252 | W8 (sekwencyjnie po register) |
| budowa modułów + nav + szkielet | 3 | — |
| równoległe ładowania ekranu (`ms:homeFanout`) | 383–506 ciepły / **6 162 zimny** | W15/W20a + zimne starty |

## 3. Backend — zimny start (zmierzone na `/api/klub`, produkcja)

```
zimny:  Server-Timing: app;dur=6.3,  cold;dur=6636, boot;dur=4032
ciepły: Server-Timing: app;dur=0.6,  cold;dur=0,    boot;dur=4032
ciepły: Server-Timing: app;dur=0.3,  cold;dur=0,    boot;dur=4032
```

| składnik | ms | komentarz |
|---|---|---|
| pełny zimny start (wiek instancji przy 1. żądaniu) | **6 636** | |
| z tego ładowanie grafu modułów (`boot`) | **4 032** | kod, którego endpoint nigdy nie używa |
| reszta (kontener + Node + framework) | ~2 600 | poza naszym wpływem |
| praca handlera (ciepło) | **0,3–0,6** | logika jest darmowa, płacimy wyłącznie za start |

**Lokalnie na tej maszynie ten sam graf ładuje się 1 207 ms / 1 739 modułów** — vCPU Cloud Run jest ~3,3× wolniejszy. Audyt 10.09 szacował koszt na ~1 s; realnie jest **czterokrotnie gorzej**.

Najdroższe handlery na ciepło (z tabeli API przebiegu 12:02:42):
`/api/admin/pending` **627 ms**, `/api/basen/sessions` **463 ms**, `/api/km/stats` 72 ms, `/api/godzinki?view=home` 76 ms.

## 4. NOWE ZNALEZISKO — W22: podwójny render ekranu startowego

Nie występuje w żadnym z trzech wcześniejszych audytów. Wykryte pierwszym uruchomieniem instrumentacji.

Przy wejściu na `https://app.morzkulc.pl/` **bez hasha** (czyli: ikona PWA, zakładka, wpisanie adresu) każdy endpoint ekranu startowego leci **dwa razy**, ~1 ms po sobie:

```
/api/events            t0=3104  |  t0=3105
/api/km/stats          t0=3104  |  t0=3105
/api/godzinki?view=home t0=3104 |  t0=3105
/api/events/interests  t0=3104  |  t0=3105
/api/basen/sessions    t0=3104  |  t0=3105
/api/admin/pending     t0=3104  |  t0=3105
```

**Przyczyna:** `app_shell.js` ustawia `location.hash` (gdy go brak), co odpala zdarzenie `hashchange` → `renderView`, a trzy linie niżej woła `await renderView(...)` jawnie. Dashboard buduje się dwa razy.

**Skutek:** 12 żądań zamiast 6. Duplikaty nie dokładają czasu szeregowo (startują równolegle), ale konkurują o łącze — druga kopia każdego żądania ma `net` 438–991 ms zamiast 179–201 ms. Backend wykonuje dwa razy więcej pracy, w tym dwa razy `/api/admin/pending` (627 ms) i `/api/basen/sessions` (463 ms).

**Nie występuje** przy przeładowaniu strony, gdy hash jest już w adresie — dlatego umknęło dotąd uwadze.

## 5. Pliki

- `runs.json` — surowe zrzuty przebiegów (`window.__PERF__.dump()`)
- Snippet zrzutu: `../snapshot.js`

## 6. Czego tu nie ma

- **Pomiaru z telefonu.** Lab na desktopie nie ma throttlingu CPU, a `ms:jsGraph` spada tam do 25–60 ms przy ciepłym cache — na telefonie parsowanie 569 KB JS jest realnym kosztem przy każdym starcie. Ten pomiar musi zrobić użytkownik, otwierając `#/home/perf` na telefonie.
- **Statystyki zimnych startów z produkcji.** `gcloud` nie działa na tej maszynie (błąd weryfikacji certyfikatu korporacyjnego CA). Kanał zastępczy: `firebase functions:log`.
