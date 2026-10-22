/**
 * Publiczne dane strony kursu (kurs.morzkulc.pl) z setup/vars_kurs (zakładka Vars_KURS
 * arkusza 1_App_SETUP). WHITELIST: na zewnątrz trafiają wyłącznie pola z KURS_VARS
 * oraz wiersze harmonogram_NN. Puste/niepoprawne wartości są pomijane — strona wtedy
 * nie wyświetla danego fragmentu (zero wartości wpisanych na sztywno w HTML).
 */

type VarsMap = Record<string, {value?: any} | undefined>;

export type KursHarmonogramItem = {
  from: string;
  to: string;
  type: string;
  name: string;
  place: string;
};

export type PublicKurs = Record<string, string | number> & {harmonogram?: KursHarmonogramItem[]};

const STATUSES = new Set(["wkrotce", "otwarte", "rezerwowa", "zamkniete"]);
const HARMONOGRAM_TYPES = new Set(["spotkanie", "wyklad", "basen", "wyjazd", "po_kursie"]);

type Kind = "num" | "text" | "date" | "url" | "email" | "status";

// zmienna arkusza → klucz w odpowiedzi
const KURS_VARS: Array<{key: string; out: string; kind: Kind}> = [
  {key: "kurs_edycja", out: "edycja", kind: "text"},
  {key: "cena_kursu", out: "cena", kind: "num"},
  {key: "kurs_cena_mlodzi", out: "cenaMlodzi", kind: "num"},
  {key: "kurs_mlodzi_wiek", out: "mlodziWiek", kind: "num"},
  {key: "kurs_start", out: "start", kind: "date"},
  {key: "kurs_zadatek", out: "zadatek", kind: "num"},
  {key: "kurs_termin_doplaty", out: "terminDoplaty", kind: "date"},
  {key: "kurs_limit_miejsc", out: "limitMiejsc", kind: "num"},
  {key: "kurs_zapisy_status", out: "zapisyStatus", kind: "status"},
  {key: "kurs_zapisy_od", out: "zapisyOd", kind: "date"},
  {key: "kurs_zapisy_do", out: "zapisyDo", kind: "date"},
  {key: "kurs_zapisy_demo_do", out: "zapisyDemoDo", kind: "date"},
  {key: "kurs_link_zapisu", out: "linkZapisu", kind: "url"},
  {key: "kurs_kontakt_email", out: "kontaktEmail", kind: "email"},
  {key: "kurs_kontakt_telefon", out: "kontaktTelefon", kind: "text"},
  {key: "kurs_baseny_w_cenie", out: "basenyWCenie", kind: "num"},
  {key: "kurs_min_basenow", out: "minBasenow", kind: "num"},
  {key: "kurs_min_wyjazdow", out: "minWyjazdow", kind: "num"},
  {key: "kurs_film_url", out: "filmUrl", kind: "url"},
];

const str = (v: any) => String(v == null ? "" : v).trim();

/** "2027-03-01" albo "01.03.2027" → "2027-03-01"; inaczej "". */
export function kursDate(raw: any): string {
  const s = str(raw);
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return "";
}

function convert(kind: Kind, raw: any): string | number | "" {
  const s = str(raw);
  if (!s) return "";
  switch (kind) {
  case "num": {
    const n = Number(s.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(n) ? n : "";
  }
  case "date": return kursDate(s);
  case "url": return /^https?:\/\/\S+$/i.test(s) ? s : "";
  case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
  case "status": return STATUSES.has(s.toLowerCase()) ? s.toLowerCase() : "";
  default: return s;
  }
}

/** "2027-04-24/2027-04-25 | wyjazd | Wyjazd I | Ostrzyce" → pozycja albo null. */
export function parseHarmonogram(raw: any): KursHarmonogramItem | null {
  const parts = str(raw).split("|").map((p) => p.trim());
  if (parts.length < 3) return null;
  const [dates, typeRaw, name, place = ""] = parts;
  const [fromRaw, toRaw = ""] = dates.split("/").map((d) => d.trim());
  const from = kursDate(fromRaw);
  const to = toRaw ? kursDate(toRaw) : "";
  const type = typeRaw.toLowerCase();
  if (!from || (toRaw && !to) || !HARMONOGRAM_TYPES.has(type) || !name) return null;
  return {from, to, type, name, place};
}

export function buildPublicKurs(vars: VarsMap | null | undefined): PublicKurs {
  const v = vars || {};
  const out: PublicKurs = {};
  for (const d of KURS_VARS) {
    const val = convert(d.kind, v[d.key]?.value);
    if (val !== "") out[d.out] = val;
  }
  const harmonogram = Object.keys(v)
    .filter((k) => /^harmonogram_\d+$/i.test(k))
    .map((k) => parseHarmonogram(v[k]?.value))
    .filter((x): x is KursHarmonogramItem => x !== null)
    .sort((a, b) => a.from.localeCompare(b.from));
  if (harmonogram.length) out.harmonogram = harmonogram;
  // Start kursu: kurs_start, a bez niej pierwsza pozycja harmonogramu.
  if (!out.start && harmonogram.length) out.start = harmonogram[0].from;
  // Zniżka wiekowa ma sens tylko jako para (cena + wiek) — inaczej żadnej z nich.
  if (!out.cenaMlodzi || !out.mlodziWiek) {
    delete out.cenaMlodzi;
    delete out.mlodziWiek;
  }
  return out;
}
