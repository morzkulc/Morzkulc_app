import {KursSignupConfig, PrzelewInfo, przelewInfo} from "./kurs_signup_config";
import {KursHarmonogramItem} from "./kurs_public";

/**
 * Mail do zgłaszającego po wysłaniu formularza: instrukcja krok po kroku, dane do
 * przelewu i harmonogram (te same wiersze harmonogram_NN co na stronie kursu).
 * Czysta funkcja — treść testowalna bez wysyłki.
 */

export const DEMO_NOTE = "TO ZGŁOSZENIE TESTOWE (tryb demo zapisów) — nie wpłacaj pieniędzy. Po zakończeniu testów zostanie usunięte.";

const MONTHS = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];
const TYPE_LABEL: Record<string, string> = {spotkanie: "spotkanie", wyklad: "wykład", basen: "basen (do wyboru)", wyjazd: "wyjazd", po_kursie: "po kursie"};

export function esc(v: any): string {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function pln(n: number | null): string {
  return n == null ? "" : `${n.toLocaleString("pl-PL")} zł`;
}

function parts(iso: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** "2027-03-01" → "1 marca 2027". */
export function dateLong(iso: string): string {
  const p = parts(iso);
  return p ? `${p[2]} ${MONTHS[p[1] - 1]} ${p[0]}` : "";
}

/** Zakres dat bez roku: "24–25 kwietnia", "30 kwietnia – 2 maja", "4 marca". */
export function rangePL(from: string, to: string): string {
  const a = parts(from);
  const b = parts(to);
  if (!a) return "";
  if (!b || from === to) return `${a[2]} ${MONTHS[a[1] - 1]}`;
  if (a[1] === b[1]) return `${a[2]}–${b[2]} ${MONTHS[b[1] - 1]}`;
  return `${a[2]} ${MONTHS[a[1] - 1]} – ${b[2]} ${MONTHS[b[1] - 1]}`;
}

function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  const d = n % 10;
  const h = n % 100;
  return d >= 2 && d <= 4 && (h < 12 || h > 14) ? few : many;
}

/** Zdanie o basenach: „wybierasz 1–2 z 5 terminów…” — z Vars_KURS, puste gdy brak danych. */
export function basenyLine(cfg: KursSignupConfig, harmonogram: KursHarmonogramItem[]): string {
  const count = harmonogram.filter((h) => h.type === "basen").length;
  if (!count) return "";
  const min = typeof cfg.kurs.minBasenow === "number" ? cfg.kurs.minBasenow : 0;
  const inc = typeof cfg.kurs.basenyWCenie === "number" ? cfg.kurs.basenyWCenie : 0;
  const range = min && inc && min < inc ? `${min}–${inc}` : String(inc || min || "");
  let s = range ?
    `Baseny: wybierasz ${range} z ${count} ${plural(count, "terminu", "terminów", "terminów")}` :
    "Baseny: terminy są do wyboru";
  if (inc) s += `, ${inc} ${plural(inc, "basen jest", "baseny są", "basenów jest")} w cenie`;
  if (inc && min) s += `, do ukończenia kursu wystarczy ${min}`;
  return s + ". Na wybrane terminy zapisujesz się w aplikacji klubowej.";
}

function przelewText(p: PrzelewInfo, kwota: number | null, label: string): string {
  return [
    `   ${label}: ${pln(kwota)}`,
    `   Numer konta: ${p.konto}${p.bank ? ` (${p.bank})` : ""}`,
    `   Tytuł przelewu: ${p.tytul}`,
  ].join("\n");
}

function przelewHtml(p: PrzelewInfo, kwota: number | null, label: string): string {
  const td = "padding:4px 12px 4px 0;color:#555";
  return "<table style=\"border-collapse:collapse;font-size:15px;margin:6px 0 4px\">" +
    `<tr><td style="${td}">${esc(label)}</td><td><b>${esc(pln(kwota))}</b></td></tr>` +
    `<tr><td style="${td}">Numer konta</td><td><b>${esc(p.konto)}</b>${p.bank ? ` (${esc(p.bank)})` : ""}</td></tr>` +
    `<tr><td style="${td}">Tytuł przelewu</td><td><b>${esc(p.tytul)}</b></td></tr></table>`;
}

export function buildApplicantMail(z: any, cfg: KursSignupConfig): {subject: string; text: string; html: string} {
  const p = przelewInfo(cfg, z);
  const harmonogram = Array.isArray(cfg.kurs.harmonogram) ? cfg.kurs.harmonogram : [];
  const baseny = basenyLine(cfg, harmonogram);
  const doplata = p.cena ?
    (p.terminDoplaty ?
      `Pozostałą kwotę do pełnej ceny kursu (${pln(p.cena)}) wpłać do ${dateLong(p.terminDoplaty)} — tym samym tytułem przelewu. To także ostatni dzień na rezygnację z kursu (regulamin).` :
      `Pozostałą kwotę do pełnej ceny kursu (${pln(p.cena)}) wpłacisz w terminie, który podamy.`) :
    "";
  const contact = typeof cfg.kurs.kontaktEmail === "string" ? cfg.kurs.kontaktEmail : "";

  const steps: Array<{title: string; text: string; html: string}> = [
    {
      title: "Wpłać zadatek — to rezerwuje Twoje miejsce",
      text: przelewText(p, p.zadatek, "Zadatek"),
      html: przelewHtml(p, p.zadatek, "Zadatek"),
    },
    {
      title: "Poczekaj na potwierdzenie",
      text: `   Po zaksięgowaniu zadatku dostaniesz maila z dostępem do aplikacji klubowej (${cfg.appUrl}).`,
      html: `Po zaksięgowaniu zadatku dostaniesz maila z dostępem do aplikacji klubowej (<a href="${esc(cfg.appUrl)}">${esc(cfg.appUrl)}</a>).`,
    },
    {
      title: "Zaloguj się do aplikacji",
      text: `   Użyj tego samego konta Google (${z.email}) i przy rejestracji zaznacz, że jesteś kursantem.`,
      html: `Użyj tego samego konta Google (<b>${esc(z.email)}</b>) i przy rejestracji zaznacz, że jesteś kursantem.`,
    },
  ];
  if (baseny) steps.push({title: "Zapisz się na baseny", text: `   ${baseny}`, html: esc(baseny)});
  if (doplata) steps.push({title: "Dopłać resztę", text: `   ${doplata}`, html: esc(doplata)});

  const hText = harmonogram.map((h) =>
    `   ${rangePL(h.from, h.to)} — ${TYPE_LABEL[h.type] || h.type}: ${h.name}${h.place ? ` (${h.place})` : ""}`);
  const hHtml = harmonogram.map((h) =>
    `<tr><td style="padding:3px 12px 3px 0;white-space:nowrap;color:#555">${esc(rangePL(h.from, h.to))}</td>` +
    `<td style="padding:3px 12px 3px 0;color:#555">${esc(TYPE_LABEL[h.type] || h.type)}</td>` +
    `<td style="padding:3px 0">${esc(h.name)}${h.place ? ` <span style="color:#555">(${esc(h.place)})</span>` : ""}</td></tr>`).join("");

  const links: string[] = [];
  if (cfg.kursUrl) {
    links.push(`Strona kursu (harmonogram, FAQ): ${cfg.kursUrl}`);
    links.push(`Regulamin kursu: ${cfg.kursUrl.replace(/\/$/, "")}/regulamin`);
  }
  if (contact) links.push(`Pytania: ${contact}`);

  const text = [
    ...(z.demo ? [DEMO_NOTE, ""] : []),
    `Cześć ${z.form.imie}!`,
    "",
    `Dziękujemy za zgłoszenie na Kurs Kajakarstwa Górskiego i Morskiego SKK Morzkulc ${z.edycja}. Co dalej:`,
    "",
    ...steps.flatMap((s, i) => [`${i + 1}. ${s.title}`, s.text, ""]),
    ...(hText.length ? [`HARMONOGRAM KURSU ${z.edycja}`, ...hText, "   Miejsca i terminy mogą się zmienić ze względów organizacyjnych lub bezpieczeństwa.", ""] : []),
    ...(links.length ? [...links, ""] : []),
    "Do zobaczenia na wodzie!",
    "SKK Morzkulc",
  ].join("\n");

  const html =
    (z.demo ? `<p style="background:#fff3cd;padding:8px 12px"><b>${esc(DEMO_NOTE)}</b></p>` : "") +
    `<p>Cześć ${esc(z.form.imie)}!</p>` +
    `<p>Dziękujemy za zgłoszenie na Kurs Kajakarstwa Górskiego i Morskiego SKK Morzkulc ${esc(z.edycja)}. Co dalej:</p>` +
    "<ol style=\"padding-left:20px\">" +
    steps.map((s) => `<li style="margin:0 0 12px"><b>${esc(s.title)}</b><br>${s.html}</li>`).join("") +
    "</ol>" +
    (hHtml ? `<h3 style="margin:20px 0 6px">Harmonogram kursu ${esc(z.edycja)}</h3>` +
      `<table style="border-collapse:collapse;font-size:14px">${hHtml}</table>` +
      "<p style=\"color:#555;font-size:13px\">Miejsca i terminy mogą się zmienić ze względów organizacyjnych lub bezpieczeństwa.</p>" : "") +
    (links.length ? `<p>${links.map((l) => esc(l).replace(/(https?:\/\/\S+)/g, "<a href=\"$1\">$1</a>")).join("<br>")}</p>` : "") +
    "<p>Do zobaczenia na wodzie!<br>SKK Morzkulc</p>";

  return {subject: `${z.demo ? "[TEST] " : ""}Zgłoszenie na Kurs ${z.edycja} — co dalej (SKK Morzkulc)`, text, html};
}
