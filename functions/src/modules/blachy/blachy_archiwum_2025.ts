/**
 * Oficjalne archiwum Blach Klubowych SKK Morzkulc do 2025 r. (arkusz „Blachy_SKK_Morzkulc”,
 * plik „blachy klubowe 2025.xls”). Jedyne właściwe zestawienie blach sprzed procedury w aplikacji —
 * wpisy są w Rejestrze (`archiwum_<poz>`) bez edycji; kolejne blachy numerowane od ARCHIWUM_MAX_NR + 1.
 */

export const ARCHIWUM_DO_ROKU = 2025;

export const ARCHIWUM_UWAGA = "Od 1981 r. (według Bogusława Kusza i Jerzego Drożdża) do 1994 r. Blachy były nienumerowane.";

export type ArchiwumBlacha = {
  /** Pozycja w zestawieniu (kolejność wyświetlania). */
  poz: number;
  /** null = blacha nienumerowana (1981–1994) albo honorowa. */
  nr: number | null;
  honorowa: boolean;
  /** YYYY-MM-DD; null = nieznana. */
  data: string | null;
  miejsce: string;
  imie: string;
  nazwisko: string;
  ksywa: string;
  /** Urodziny / jubileusz klubu, na których nadano blachę. */
  okazja: string;
};

export const ARCHIWUM_2025: ArchiwumBlacha[] = [
  {poz: 1, nr: null, honorowa: false, data: null, miejsce: "", imie: "Maciej", nazwisko: "Skarbek", ksywa: "Macias", okazja: ""},
  {poz: 2, nr: null, honorowa: false, data: null, miejsce: "", imie: "Mariusz", nazwisko: "Maleszewski", ksywa: "Malosz", okazja: ""},
  {poz: 3, nr: 0, honorowa: false, data: "1996-12-14", miejsce: "Borkowo", imie: "Artur", nazwisko: "Roman", ksywa: "Melon", okazja: "XXI urodziny"},
  {poz: 4, nr: 1, honorowa: false, data: "1996-12-14", miejsce: "Borkowo", imie: "Barbara", nazwisko: "Jakołcewicz", ksywa: "Bacha", okazja: "XXI urodziny"},
  {poz: 5, nr: 2, honorowa: false, data: "1997-12-13", miejsce: "Zawory", imie: "Robert", nazwisko: "Salgado", ksywa: "Roberto", okazja: "XXII urodziny"},
  {poz: 6, nr: 3, honorowa: false, data: "1997-12-13", miejsce: "Zawory", imie: "Dorota", nazwisko: "Krasicka", ksywa: "Dorotka", okazja: "XXII urodziny"},
  {poz: 7, nr: 4, honorowa: false, data: "1997-12-13", miejsce: "Zawory", imie: "Marcin", nazwisko: "Ardanowski", ksywa: "Ardan", okazja: "XXII urodziny"},
  {poz: 8, nr: null, honorowa: true, data: "1997-12-13", miejsce: "Zawory", imie: "Piotr", nazwisko: "Darkowski", ksywa: "Darecki", okazja: "XXII urodziny"},
  {poz: 9, nr: 5, honorowa: false, data: "1998-12-12", miejsce: "Sianowo Leśne", imie: "Błażej", nazwisko: "Zieliński", ksywa: "Blazewia", okazja: "XXIII urodziny"},
  {poz: 10, nr: 6, honorowa: false, data: "1998-12-12", miejsce: "Sianowo Leśne", imie: "Marcin", nazwisko: "Stachula", ksywa: "Smoleń", okazja: "XXIII urodziny"},
  {poz: 11, nr: 7, honorowa: false, data: "2000-12-09", miejsce: "Borsk", imie: "Grzegorz", nazwisko: "Pestka", ksywa: "Grzepe", okazja: "XXV urodziny"},
  {poz: 12, nr: 8, honorowa: false, data: "2001-12-15", miejsce: "Sianowo Leśne", imie: "Adam", nazwisko: "Kaczyński", ksywa: "Kaczor", okazja: "XXVI urodziny"},
  {poz: 13, nr: 9, honorowa: false, data: "2002-12-14", miejsce: "Sianowo Leśne", imie: "Małgorzata", nazwisko: "Paszotta", ksywa: "Margot", okazja: "XXVII urodziny"},
  {poz: 14, nr: 10, honorowa: false, data: "2002-12-14", miejsce: "Sianowo Leśne", imie: "Anna", nazwisko: "Spiczak-Brzezińska", ksywa: "Andzia", okazja: "XXVII urodziny"},
  {poz: 15, nr: 11, honorowa: false, data: "2002-12-14", miejsce: "Sianowo Leśne", imie: "Tomasz", nazwisko: "Gromadzki", ksywa: "Grom", okazja: "XXVII urodziny"},
  {poz: 16, nr: 12, honorowa: false, data: "2003-12-13", miejsce: "Leśna Huta", imie: "Jacek", nazwisko: "Uznański", ksywa: "Jaca", okazja: "XXVIII urodziny"},
  {poz: 17, nr: 13, honorowa: false, data: "2003-12-13", miejsce: "Leśna Huta", imie: "Dorota", nazwisko: "Górska", ksywa: "Helga", okazja: "XXVIII urodziny"},
  {poz: 18, nr: 14, honorowa: false, data: "2004-12-11", miejsce: "Wygonin", imie: "Grzegorz", nazwisko: "Woźniak", ksywa: "Bestya", okazja: "XXIX urodziny"},
  {poz: 19, nr: 15, honorowa: false, data: "2004-12-11", miejsce: "Wygonin", imie: "Wiktor", nazwisko: "Fikier", ksywa: "Oskar", okazja: "XXIX urodziny"},
  {poz: 20, nr: 16, honorowa: false, data: "2006-12-16", miejsce: "Bartel Wielki", imie: "Paweł", nazwisko: "Strzelecki", ksywa: "Poziomka", okazja: "XXXI urodziny"},
  {poz: 21, nr: 17, honorowa: false, data: "2006-12-16", miejsce: "Bartel Wielki", imie: "Jacek", nazwisko: "Seroczyński", ksywa: "Dżejson", okazja: "XXXI urodziny"},
  {poz: 22, nr: 18, honorowa: false, data: "2006-12-16", miejsce: "Bartel Wielki", imie: "Agnieszka", nazwisko: "Gałka", ksywa: "Gałka", okazja: "XXXI urodziny"},
  {poz: 23, nr: null, honorowa: true, data: "2007-12-15", miejsce: "Ocypel", imie: "Mariusz", nazwisko: "Sośnicki", ksywa: "Sosna", okazja: "XXXII urodziny"},
  {poz: 24, nr: 19, honorowa: false, data: "2008-12-20", miejsce: "Żelistrzewo", imie: "Paweł", nazwisko: "Polański", ksywa: "Polmos", okazja: "XXXIII urodziny"},
  {poz: 25, nr: 20, honorowa: false, data: "2009-12-05", miejsce: "Wygonin", imie: "Marcin", nazwisko: "Pstrong", ksywa: "Rekin", okazja: "XXXIV urodziny"},
  {poz: 26, nr: null, honorowa: true, data: "2010-12-17", miejsce: "Bartel Wielki", imie: "Marcin", nazwisko: "Powroźnik", ksywa: "Cinek", okazja: "XXXV urodziny"},
  {poz: 27, nr: 21, honorowa: false, data: "2010-12-17", miejsce: "Bartel Wielki", imie: "Michał", nazwisko: "Mikucki", ksywa: "Duży", okazja: "XXXV urodziny"},
  {poz: 28, nr: 22, honorowa: false, data: "2010-12-18", miejsce: "Bartel Wielki", imie: "Tomasz", nazwisko: "Kubiak - Bielski", ksywa: "Tomi", okazja: "XXXV urodziny"},
  {poz: 29, nr: 23, honorowa: false, data: "2011-12-10", miejsce: "Bartel Wielki", imie: "Prakseda", nazwisko: "Hirsch", ksywa: "Praksa", okazja: "XXXVI urodziny"},
  {poz: 30, nr: 24, honorowa: false, data: "2011-12-10", miejsce: "Bartel Wielki", imie: "Łukasz", nazwisko: "Orzeszyna", ksywa: "Orzech", okazja: "XXXVI urodziny"},
  {poz: 31, nr: 25, honorowa: false, data: "2012-12-15", miejsce: "Wygonin", imie: "Radosław", nazwisko: "Orłowski", ksywa: "Radziu", okazja: "XXXVII urodziny"},
  {poz: 32, nr: 26, honorowa: false, data: "2014-12-06", miejsce: "Chmielno", imie: "Dominika", nazwisko: "Opałka", ksywa: "Zapałka", okazja: "XXXIX urodziny"},
  {poz: 33, nr: 27, honorowa: false, data: "2015-08-08", miejsce: "Swornegacie", imie: "Sylwia", nazwisko: "Gontarczyk (z d. Przybysz)", ksywa: "Skula", okazja: "Jubileusz XL"},
  {poz: 34, nr: 28, honorowa: false, data: "2015-12-12", miejsce: "Bartel Wielki", imie: "Marcin", nazwisko: "Grzyś", ksywa: "Marian", okazja: "XL urodziny"},
  {poz: 35, nr: 29, honorowa: false, data: "2016-12-10", miejsce: "Bartel Wielki", imie: "Łukasz", nazwisko: "Opałka", ksywa: "Zapał", okazja: "XLI urodziny"},
  {poz: 36, nr: 30, honorowa: false, data: "2016-12-10", miejsce: "Bartel Wielki", imie: "Jakub", nazwisko: "Żelazkiewicz", ksywa: "Żelazo", okazja: "XLI urodziny"},
  {poz: 37, nr: 31, honorowa: false, data: "2018-12-08", miejsce: "Bartel Wielki", imie: "Paweł", nazwisko: "Niedźwiecki", ksywa: "Niedźwiedź", okazja: "XLIII urodziny"},
  {poz: 38, nr: 32, honorowa: false, data: "2018-12-08", miejsce: "Bartel Wielki", imie: "Monika", nazwisko: "Milewczyk", ksywa: "Monia", okazja: "XLIII urodziny"},
  {poz: 39, nr: 33, honorowa: false, data: "2020-12-19", miejsce: "Miedzno", imie: "Szymon", nazwisko: "Winczewski", ksywa: "Szywi", okazja: "XLV urodziny"},
  {poz: 40, nr: 34, honorowa: false, data: "2022-01-13", miejsce: "Bartel Wielki", imie: "Anna", nazwisko: "Siedlecka", ksywa: "Aneczka", okazja: "XLVI urodziny"},
  {poz: 41, nr: 35, honorowa: false, data: "2023-01-14", miejsce: "Bartel Wielki", imie: "Wojciech", nazwisko: "Reducha", ksywa: "Pagaj", okazja: "XLVII urodziny"},
  {poz: 42, nr: 36, honorowa: false, data: "2023-01-14", miejsce: "Bartel Wielki", imie: "Marcin", nazwisko: "Korbas", ksywa: "Gruby", okazja: "XLVII urodziny"},
  {poz: 43, nr: 37, honorowa: false, data: "2024-02-24", miejsce: "Miedzno", imie: "Radosław", nazwisko: "Orzłowski", ksywa: "Orzeł", okazja: "XLVIII urodziny"},
  {poz: 44, nr: 38, honorowa: false, data: "2025-09-06", miejsce: "Swornegacie", imie: "Weronika", nazwisko: "Lutostańska", ksywa: "Weri", okazja: "Jubileusz L"},
  {poz: 45, nr: 39, honorowa: false, data: "2025-09-06", miejsce: "Swornegacie", imie: "Dorota", nazwisko: "Zdrojewska", ksywa: "Dorotka", okazja: "Jubileusz L"},
];

/** Najwyższy numer w archiwum — procedura nadaje kolejne. */
export const ARCHIWUM_MAX_NR = Math.max(...ARCHIWUM_2025.map((b) => b.nr ?? -1));
