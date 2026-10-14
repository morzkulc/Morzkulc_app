# Wizytówka www.morzkulc.pg.gda.pl

Statyczna strona zastępująca WordPressa 3.1.1 na serwerze PG. Nie ma PHP, bazy ani formularzy.
Imprezy, zarząd, adres i socjale pobiera w przeglądarce z `https://app.morzkulc.pl/api/public/site` (funkcja `publicSiteInfo`).
Gdy API nie odpowie, pokazuje link do publicznego kalendarza Google i statyczny kontakt.

## Pliki
| Plik | Co |
|---|---|
| `index.html` | cała strona (CSS + JS inline) |
| `img/hero.jpg` | nagłówek (Soča z drona) |
| `img/morze.jpg`, `img/gory.jpg` | karty kursu |
| `img/foto1.jpg` … `img/foto10.jpg` | galeria (10 zdjęć) |
| `img/logo.jpg`, `img/icon.png` | logo w nagłówku + ikona karty |
| `_oryginaly/` | zdjęcia źródłowe — **NIE wgrywać** |

Na FTP idą tylko: `index.html` + `img/`.

## Dane z aplikacji (arkusz SETUP, zakładka `Vars_CZLONKOWIE`)
| Zmienna | Efekt |
|---|---|
| `facebook_url` | przycisk Facebook |
| `instagram_url` | przycisk Instagram |
| `kurs_url` | cel przycisku „Szczegóły i zapisy” (domyślnie www.morzkulc.pl) |
| `adres_klub` | „Siedziba klubu: …” |

Zarząd bierze się z funkcji (prezes/skarbnik/sprzętowiec/szkoleniowiec), tak jak w module Klub. Odpowiedź API jest cache'owana 15 min.

## Procedura na serwerze FTP
1. **Kopia:** pobierz CAŁY katalog www (FileZilla → prawy klik → Pobierz) do archiwum klubowego.
2. **Usuń wszystko z katalogu www:** `wp-admin/`, `wp-content/`, `wp-includes/`, wszystkie `*.php`, `readme.html`, `license.txt`, `.htaccess`, `statuty/` i inne.
3. **Wgraj** `index.html` i katalog `img/`.
4. **Sprawdź:**
   - `http://www.morzkulc.pg.gda.pl/` pokazuje nową stronę;
   - `/wp-login.php` i `/readme.html` zwracają 404;
   - lista imprez się ładuje.
