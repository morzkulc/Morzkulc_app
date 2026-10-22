/**
 * Zgłoszenia na kurs (formularz kurs.morzkulc.pl/zapis) — logika bez I/O:
 * walidacja formularza, tytuł przelewu, kolejność listy głównej/rezerwowej,
 * dopasowanie nagłówków arkusza członków.
 *
 * Kolekcja: kurs_zgloszenia/{edycja}_{email}. Statusy:
 *   nowe → zadatek (przeniesienie do arkusza członków = dostęp do aplikacji)
 *        → oplacony (opłata za kurs = pełna cena) ; rezygnacja z każdego.
 * Zakresy waga/wzrost/PESEL są wspólne z walidacją kursanta w
 * usersSyncFieldsFromSheet.ts — inaczej przeniesiony wiersz mógłby zablokować sync.
 */

export const KURSANT_LIMITS = {wagaMin: 30, wagaMax: 250, wzrostMin: 100, wzrostMax: 230};

export const ZGLOSZENIA_COLLECTION = "kurs_zgloszenia";

export type ZgloszenieStatus = "nowe" | "zadatek" | "oplacony" | "rezygnacja";

export const DOSWIADCZENIE = [
  "Nigdy",
  "Kilka razy rekreacyjnie",
  "Regularnie pływam turystycznie",
  "Mam doświadczenie w kajakarstwie morskim lub górskim",
];
export const PLYWANIE = ["Podstawowa", "Dobra", "Bardzo dobra", "Bardzo dobra, czuję się pewnie w wodzie"];
export const SCHORZENIA = [
  "Astma", "Silne alergie", "Cukrzyca", "Padaczka", "Choroby serca", "Choroba lokomocyjna",
  "Inne schorzenie mogące mieć znaczenie podczas kursu", "Żadne z powyższych",
];
export const ZAINTERESOWANIA = [
  "Kajakarstwo morskie", "Kajakarstwo górskie", "Wyprawy", "Doskonalenie techniki",
  "Aktywność fizyczna", "Poznanie nowych ludzi", "Jeszcze nie wiem",
];
export const SKAD = [
  "Facebook", "Instagram", "Znajomi", "Członek Morzkulca", "Uczelnia", "Google", "Plakat",
  "Zawieszony kajak", "Inne",
];

export type ZgloszenieForm = {
  imie: string;
  nazwisko: string;
  telefon: string;
  dataUrodzenia: string; // YYYY-MM-DD
  miejscowosc: string;
  pesel: string; // "" gdy brakPesel
  brakPesel: boolean;
  dokument: string; // numer paszportu / dowodu — wymagany, gdy brakPesel
  iceImie: string;
  iceTelefon: string;
  doswiadczenie: string;
  plywanie: string;
  sporty: string;
  chorobyPrzewlekle: boolean;
  chorobyOpis: string;
  leki: boolean;
  lekiOpis: string;
  schorzenia: string[];
  wzrost: number;
  waga: number;
  student: boolean;
  uczelnia: string;
  dieta: "wszystko" | "wege";
  wegeMieso: string; // "Nie" | "Tak" | ""
  dlaczego: string;
  zainteresowania: string[];
  rokPoKursie: string;
  pasje: string;
  dlaczegoTy: string;
  skad: string;
  zgodaRegulamin: boolean;
  zgodaZdrowie: boolean;
  // Te same zgody co przy rejestracji w aplikacji (render_shell.js: consentRodo / consentStatute)
  // → „Zgody RODO” = TAK w arkuszu członków.
  zgodaRodo: boolean;
  zgodaStatut: boolean;
  zgodaWizerunek: boolean;
};

const MAX_SHORT = 200;
const MAX_LONG = 3000;

const s = (v: any, max = MAX_SHORT) => String(v == null ? "" : v).trim().slice(0, max);
const b = (v: any) => v === true || v === "true" || v === "tak";

/** PESEL: 11 cyfr + poprawna cyfra kontrolna. */
export function isValidPesel(pesel: string): boolean {
  if (!/^\d{11}$/.test(pesel)) return false;
  const w = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  const sum = w.reduce((acc, wi, i) => acc + wi * Number(pesel[i]), 0);
  return (10 - (sum % 10)) % 10 === Number(pesel[10]);
}

/** Pełnoletność w dniu `todayIso` (urodziny w dniu zgłoszenia liczą się jako ukończone 18 lat). */
export function isAdult(birthIso: string, todayIso: string): boolean {
  const [y, m, d] = birthIso.split("-");
  return `${Number(y) + 18}-${m}-${d}` <= todayIso;
}

function isPhone(v: string): boolean {
  return /^\+?[\d\s-]{9,20}$/.test(v) && v.replace(/\D/g, "").length >= 9;
}

function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function num(v: any): number | null {
  const n = Number(String(v == null ? "" : v).replace(",", ".").trim());
  return Number.isFinite(n) ? n : null;
}

function pickList(v: any, allowed: string[]): string[] {
  const arr = Array.isArray(v) ? v : [];
  return Array.from(new Set(arr.map((x) => s(x)).filter((x) => allowed.includes(x))));
}

/**
 * Waliduje treść formularza. Zwraca znormalizowane dane albo listę błędnych pól
 * (klucze pól formularza → komunikat), żeby strona mogła je podświetlić.
 */
export function validateZgloszenie(body: any, todayIso: string):
  {ok: true; data: ZgloszenieForm} | {ok: false; fields: Record<string, string>} {
  const f: Record<string, string> = {};
  const req = (key: string, val: string, msg = "Pole wymagane") => {
    if (!val) f[key] = msg;
  };

  const imie = s(body?.imie);
  const nazwisko = s(body?.nazwisko);
  const telefon = s(body?.telefon, 30);
  const dataUrodzenia = s(body?.dataUrodzenia, 10);
  const miejscowosc = s(body?.miejscowosc);
  const brakPesel = body?.brakPesel === true;
  const pesel = brakPesel ? "" : s(body?.pesel, 20).replace(/\s/g, "");
  const dokument = brakPesel ? s(body?.dokument, 40) : "";
  const iceImie = s(body?.iceImie);
  const iceTelefon = s(body?.iceTelefon, 30);
  req("imie", imie);
  req("nazwisko", nazwisko);
  req("miejscowosc", miejscowosc);
  req("iceImie", iceImie);
  if (!isPhone(telefon)) f.telefon = "Podaj numer telefonu (min. 9 cyfr)";
  if (!isPhone(iceTelefon)) f.iceTelefon = "Podaj numer telefonu (min. 9 cyfr)";
  if (!isIsoDate(dataUrodzenia) || dataUrodzenia >= todayIso) f.dataUrodzenia = "Podaj poprawną datę urodzenia";
  else if (!isAdult(dataUrodzenia, todayIso)) f.dataUrodzenia = "Kurs jest tylko dla osób pełnoletnich";
  // Obcokrajowcy bez PESEL podają numer paszportu lub dowodu (ubezpieczenie NNW).
  if (brakPesel) {
    if (dokument.replace(/\s/g, "").length < 5) f.dokument = "Podaj numer paszportu lub dowodu osobistego";
  } else if (!isValidPesel(pesel)) {
    f.pesel = "Niepoprawny numer PESEL";
  }

  const doswiadczenie = s(body?.doswiadczenie);
  const plywanie = s(body?.plywanie);
  if (!DOSWIADCZENIE.includes(doswiadczenie)) f.doswiadczenie = "Wybierz odpowiedź";
  if (!PLYWANIE.includes(plywanie)) f.plywanie = "Wybierz odpowiedź";

  const chorobyPrzewlekle = b(body?.chorobyPrzewlekle);
  const chorobyOpis = chorobyPrzewlekle ? s(body?.chorobyOpis, MAX_LONG) : "";
  const leki = b(body?.leki);
  const lekiOpis = leki ? s(body?.lekiOpis, MAX_LONG) : "";
  if (typeof body?.chorobyPrzewlekle !== "boolean") f.chorobyPrzewlekle = "Wybierz odpowiedź";
  if (typeof body?.leki !== "boolean") f.leki = "Wybierz odpowiedź";
  if (chorobyPrzewlekle) req("chorobyOpis", chorobyOpis, "Opisz, na co chorujesz");
  if (leki) req("lekiOpis", lekiOpis, "Wpisz, jakie leki przyjmujesz");
  let schorzenia = pickList(body?.schorzenia, SCHORZENIA);
  if (schorzenia.includes("Żadne z powyższych") && schorzenia.length > 1) {
    schorzenia = schorzenia.filter((x) => x !== "Żadne z powyższych");
  }

  const wzrost = num(body?.wzrost);
  const waga = num(body?.waga);
  if (wzrost === null || wzrost < KURSANT_LIMITS.wzrostMin || wzrost > KURSANT_LIMITS.wzrostMax) {
    f.wzrost = `Podaj wzrost w cm (${KURSANT_LIMITS.wzrostMin}–${KURSANT_LIMITS.wzrostMax})`;
  }
  if (waga === null || waga < KURSANT_LIMITS.wagaMin || waga > KURSANT_LIMITS.wagaMax) {
    f.waga = `Podaj wagę w kg (${KURSANT_LIMITS.wagaMin}–${KURSANT_LIMITS.wagaMax})`;
  }

  if (typeof body?.student !== "boolean") f.student = "Wybierz odpowiedź";
  const student = b(body?.student);
  const uczelnia = student ? s(body?.uczelnia) : "";
  if (student) req("uczelnia", uczelnia, "Podaj uczelnię");
  const dieta = s(body?.dieta) === "wege" ? "wege" : s(body?.dieta) === "wszystko" ? "wszystko" : "";
  if (!dieta) f.dieta = "Wybierz odpowiedź";
  const wegeMieso = dieta === "wege" ? (["Nie", "Tak"].includes(s(body?.wegeMieso)) ? s(body?.wegeMieso) : "") : "";

  const skad = s(body?.skad);
  if (!SKAD.includes(skad)) f.skad = "Wybierz odpowiedź";

  if (body?.zgodaRegulamin !== true) f.zgodaRegulamin = "Wymagana akceptacja regulaminu";
  if (body?.zgodaZdrowie !== true) f.zgodaZdrowie = "Wymagane potwierdzenie";
  if (body?.zgodaRodo !== true) f.zgodaRodo = "Wymagana akceptacja polityki prywatności";
  if (body?.zgodaStatut !== true) f.zgodaStatut = "Wymagana akceptacja statutu i regulaminów";

  if (Object.keys(f).length) return {ok: false, fields: f};

  return {
    ok: true,
    data: {
      imie, nazwisko, telefon, dataUrodzenia, miejscowosc, pesel, brakPesel, dokument, iceImie, iceTelefon,
      doswiadczenie, plywanie, sporty: s(body?.sporty, MAX_LONG),
      chorobyPrzewlekle, chorobyOpis, leki, lekiOpis, schorzenia,
      wzrost: wzrost as number, waga: waga as number,
      student, uczelnia, dieta: dieta as "wszystko" | "wege", wegeMieso,
      dlaczego: s(body?.dlaczego, MAX_LONG),
      zainteresowania: pickList(body?.zainteresowania, ZAINTERESOWANIA),
      rokPoKursie: s(body?.rokPoKursie, MAX_LONG),
      pasje: s(body?.pasje, MAX_LONG),
      dlaczegoTy: s(body?.dlaczegoTy, MAX_LONG),
      skad,
      zgodaRegulamin: true,
      zgodaZdrowie: true,
      zgodaRodo: true,
      zgodaStatut: true,
      zgodaWizerunek: body?.zgodaWizerunek === true,
    },
  };
}

export function zgloszenieDocId(edycja: string, email: string): string {
  return `${edycja}_${email.trim().toLowerCase()}`;
}

/** Tytuł przelewu — ten sam na stronie, w mailu i w panelu (łatwe dopasowanie wpłat). */
export function przelewTitle(edycja: string, imie: string, nazwisko: string): string {
  return `Kurs ${edycja} – ${imie} ${nazwisko}`.trim();
}

/** Czy w dniu `refIso` osoba urodzona `birthIso` nie ukończyła jeszcze `age` lat. */
export function isYoungerThan(birthIso: string, age: number, refIso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthIso || "");
  if (!m) return false;
  return `${Number(m[1]) + age}-${m[2]}-${m[3]}` > refIso;
}

export type KursCeny = {
  cena: number | null;
  cenaMlodzi: number | null;
  mlodziWiek: number | null;
  /** Dzień, na który liczy się wiek (start kursu). */
  refIso: string;
};

/** Kwota do zapłaty: cena ulgowa, jeśli w dniu startu kursu zgłaszający nie skończył `mlodziWiek` lat; inaczej pełna. */
export function cenaFor(o: {dataUrodzenia?: string}, c: KursCeny): number | null {
  if (c.cenaMlodzi && c.mlodziWiek && isYoungerThan(o.dataUrodzenia || "", c.mlodziWiek, c.refIso)) return c.cenaMlodzi;
  return c.cena;
}

export type ListaItem = {
  id: string;
  status: ZgloszenieStatus;
  createdAtMs: number;
  zadatekAtMs: number | null;
};

/**
 * Lista główna / rezerwowa (regulamin: decyduje kolejność kompletnych zgłoszeń i wpłat):
 * najpierw osoby z wpłaconym zadatkiem (wg daty wpłaty), potem pozostałe (wg daty
 * zgłoszenia). Pierwsze `limit` pozycji = lista główna. Rezygnacje pomijane.
 * Bez limitu wszyscy są na liście głównej.
 */
export function computeListy(items: ListaItem[], limit: number | null): Map<string, {pozycja: number; lista: "glowna" | "rezerwowa"}> {
  const active = items.filter((x) => x.status !== "rezygnacja");
  const paid = active.filter((x) => x.zadatekAtMs !== null)
    .sort((a, c) => (a.zadatekAtMs as number) - (c.zadatekAtMs as number) || a.createdAtMs - c.createdAtMs);
  const unpaid = active.filter((x) => x.zadatekAtMs === null).sort((a, c) => a.createdAtMs - c.createdAtMs);
  const out = new Map<string, {pozycja: number; lista: "glowna" | "rezerwowa"}>();
  [...paid, ...unpaid].forEach((x, i) => {
    out.set(x.id, {pozycja: i + 1, lista: !limit || i < limit ? "glowna" : "rezerwowa"});
  });
  return out;
}

/** Nagłówek arkusza → klucz porównawczy (ten sam algorytm co sync pól członków). */
export function normalizeSheetHeader(h: string): string {
  return String(h == null ? "" : h).trim().toLowerCase()
    .split(" ").join("_").split("-").join("_")
    .replace(/ą/g, "a").replace(/ć/g, "c").replace(/ę/g, "e").replace(/ł/g, "l")
    .replace(/ń/g, "n").replace(/ó/g, "o").replace(/ś/g, "s").replace(/ż/g, "z").replace(/ź/g, "z")
    .replace(/[^a-z0-9_]/g, "");
}

/** Mapuje klucze znormalizowane → faktyczne nagłówki arkusza; brakujące zwraca osobno. */
export function resolveSheetHeaders(headers: string[], wanted: string[]): {map: Record<string, string>; missing: string[]} {
  const byKey = new Map<string, string>();
  for (const h of headers) {
    const k = normalizeSheetHeader(h);
    if (k && !byKey.has(k)) byKey.set(k, h);
  }
  const map: Record<string, string> = {};
  const missing: string[] = [];
  for (const w of wanted) {
    const h = byKey.get(w);
    if (h) map[w] = h;
    else missing.push(w);
  }
  return {map, missing};
}
