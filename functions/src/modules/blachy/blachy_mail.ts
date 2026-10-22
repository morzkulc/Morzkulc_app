/**
 * Treść maili procedury Blach. Każda funkcja zwraca {subject, text, html} dla sendGenericEmailHtml.
 * Poufność (§3 pkt 7, §6 pkt 3): na listę dyskusyjną nigdy nie trafiają nazwiska kandydatów przed ogłoszeniem.
 */
import {esc} from "../kurs/kurs_zgloszenia_mail";
import {BlachyConfig, OBSZARY, PROG_WYBORU, SEATS} from "./blachy_procedura";

export type Mail = {subject: string; text: string; html: string};

const MIESIACE = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];
export function dataPL(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${Number(m[3])} ${MIESIACE[Number(m[2]) - 1]} ${m[1]}` : iso;
}

function build(subject: string, paras: string[], footer = "Zarząd SKK Morzkulc"): Mail {
  const text = [...paras, "", footer].join("\n\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${
    paras.map((p) => `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, "<br>")}</p>`).join("")
  }<p style="margin:16px 0 0;color:#555">${esc(footer)}</p></div>`;
  return {subject, text, html};
}

export function mailOtwarcie(cfg: BlachyConfig, appUrl: string, regulaminUrl: string): Mail {
  return build(`Blachy Klubowe ${cfg.rok}: zgłaszanie kandydatów do ${dataPL(cfg.nominacjeDo)}`, [
    `Rozpoczynamy coroczną procedurę nadawania Blach Klubowych. Do ${dataPL(cfg.nominacjeDo)} każdy aktualny członek Klubu może zgłosić kandydata.`,
    "Kandydatem może być obecny lub były członek Morzkulca albo osoba spoza Klubu, która ma zasługi dla Morzkulca. Nie można zgłosić siebie. Osoba spoza Klubu zgłasza kandydata przez członka Klubu.",
    `Zgłoszenie zawiera opis konkretnych zasług i uzasadnienie. Oceniamy: ${OBSZARY.join(", ").toLowerCase()}. Jedno zgłoszenie wystarcza, liczba zgłoszeń nie wpływa na ocenę. Lista kandydatów jest poufna.`,
    `Formularz: aplikacja klubowa → Klub → Blachy (${appUrl}).`,
    ...(regulaminUrl ? [`Regulamin: ${regulaminUrl}`] : []),
    `Harmonogram: nominacje do ${dataPL(cfg.nominacjeDo)}, weryfikacja do ${dataPL(cfg.weryfikacjaDo)}, głosowanie Kapituły do ${dataPL(cfg.glosowanieDo)}, zatwierdzenie przez Zarząd do ${dataPL(cfg.zatwierdzenieDo)}.`,
  ]);
}

export function mailPrzypomnienie(cfg: BlachyConfig, appUrl: string): Mail {
  return build(`Blachy Klubowe ${cfg.rok}: zgłoszenia jeszcze do ${dataPL(cfg.nominacjeDo)}`, [
    `Przypominamy: zgłoszenia kandydatów do Blach Klubowych przyjmujemy do ${dataPL(cfg.nominacjeDo)}.`,
    `Formularz: aplikacja klubowa → Klub → Blachy (${appUrl}).`,
  ]);
}

export function mailZamkniecie(cfg: BlachyConfig): Mail {
  return build(`Blachy Klubowe ${cfg.rok}: nominacje zamknięte`, [
    "Przyjmowanie zgłoszeń do Blach Klubowych zakończone. Zgłoszenia trafiły do Kapituły Blach.",
    `Kapituła głosuje do ${dataPL(cfg.glosowanieDo)}, a Zarząd zatwierdza wyniki do ${dataPL(cfg.zatwierdzenieDo)}. Wyniki ogłosimy po zatwierdzeniu.`,
  ]);
}

export type DossierItem = {
  label: string;
  spozaKlubu: boolean;
  nominacje: Array<{autor: string; obszary: string[]; zaslugi: string; uzasadnienie: string}>;
};

/** Jedno zestawienie dla Kapituły: kandydat = jedna sekcja ze wszystkimi zgłoszeniami (§3 pkt 5 — bez rankingu). */
export function mailDossier(cfg: BlachyConfig, items: DossierItem[], appUrl: string): Mail {
  const subject = `Blachy Klubowe ${cfg.rok}: zestawienie kandydatur dla Kapituły (${items.length})`;
  const intro = [
    `Nominacje zamknięte ${dataPL(cfg.nominacjeDo)}. Kandydatur: ${items.length}. Zgłoszenia tej samej osoby są połączone w jedną kandydaturę.`,
    `Weryfikacja (łączenie, odrzucenie nieprawidłowych) do ${dataPL(cfg.weryfikacjaDo)}, głosowanie do ${dataPL(cfg.glosowanieDo)}. Blacha: co najmniej ${PROG_WYBORU} głosy TAK z ${SEATS}.`,
    `Panel Kapituły: aplikacja → Klub → Blachy (${appUrl}). Treść jest poufna (§6 pkt 3).`,
  ];
  const textItems = items.map((it, i) => [
    `${i + 1}. ${it.label}${it.spozaKlubu ? " — osoba spoza listy członków" : ""} (zgłoszeń: ${it.nominacje.length})`,
    ...it.nominacje.map((n) => [
      `   Zgłasza: ${n.autor}${n.obszary.length ? ` · obszary: ${n.obszary.join(", ")}` : ""}`,
      `   Zasługi: ${n.zaslugi}`,
      `   Uzasadnienie: ${n.uzasadnienie}`,
    ].join("\n")),
  ].join("\n\n"));
  const text = [...intro, "", ...textItems, "", "Zarząd SKK Morzkulc (wiadomość automatyczna)"].join("\n\n");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">${
    intro.map((p) => `<p style="margin:0 0 10px">${esc(p)}</p>`).join("")}${
    items.map((it, i) => `<h3 style="margin:22px 0 6px;font-size:17px">${i + 1}. ${esc(it.label)}${
      it.spozaKlubu ? " <span style=\"color:#777;font-weight:normal\">— osoba spoza listy członków</span>" : ""}</h3>${
      it.nominacje.map((n) => `<div style="border-left:3px solid #ccc;padding:4px 0 4px 12px;margin:8px 0">
        <div style="color:#555;font-size:13px">Zgłasza: ${esc(n.autor)}${n.obszary.length ? ` · ${esc(n.obszary.join(", "))}` : ""}</div>
        <div><b>Zasługi:</b> ${esc(n.zaslugi).replace(/\n/g, "<br>")}</div>
        <div><b>Uzasadnienie:</b> ${esc(n.uzasadnienie).replace(/\n/g, "<br>")}</div></div>`).join("")}`).join("")
  }<p style="margin:16px 0 0;color:#555">Zarząd SKK Morzkulc (wiadomość automatyczna)</p></div>`;
  return {subject, text, html};
}

export function mailNominacjaPotwierdzenie(rok: number, kandydat: string, nominacjeDo: string): Mail {
  return build(`Blachy Klubowe ${rok}: przyjęliśmy Twoje zgłoszenie`, [
    `Dziękujemy. Twoje zgłoszenie kandydatury: ${kandydat} zostało zapisane.`,
    `Do ${dataPL(nominacjeDo)} możesz je poprawić albo wycofać w aplikacji (Klub → Blachy). Potem trafi do Kapituły Blach.`,
    "Zgłoszenie jest poufne. Po zakończeniu procedury dostaniesz informację o jego rozpatrzeniu.",
  ]);
}

export function mailPrzyjecie(rok: number, kandydat: string, linkTak: string, linkNie: string): Mail {
  const subject = `Blacha Klubowa Morzkulca ${rok}`;
  const paras = [
    `${kandydat}, Kapituła Blach wybrała Cię do nadania Blachy Klubowej Morzkulca, a Zarząd zatwierdził tę decyzję.`,
    "Zanim ogłosimy wyróżnienie, prosimy o potwierdzenie, że je przyjmujesz (regulamin §5 pkt 12).",
    `Przyjmuję: ${linkTak}`,
    `Nie przyjmuję: ${linkNie}`,
    "Do czasu ogłoszenia prosimy o zachowanie tej informacji dla siebie.",
  ];
  const m = build(subject, paras);
  m.html = m.html
    .replace(esc(`Przyjmuję: ${linkTak}`), `<a href="${esc(linkTak)}" style="display:inline-block;padding:10px 18px;background:#1a7f37;color:#fff;border-radius:8px;text-decoration:none">Przyjmuję Blachę</a>`)
    .replace(esc(`Nie przyjmuję: ${linkNie}`), `<a href="${esc(linkNie)}" style="color:#555">Nie przyjmuję</a>`);
  return m;
}

export type Laureat = {label: string; uzasadnienie: string; nr: number | null};

export function mailOgloszenie(rok: number, rozpatrzone: number, laureaci: Laureat[], appUrl: string): Mail {
  const lista = laureaci.length ?
    laureaci.map((l) => `${l.label}${l.nr != null ? ` — Blacha nr ${l.nr}` : ""}\nUzasadnienie: ${l.uzasadnienie}`) :
    ["W tym roku Kapituła nie przyznała Blachy (regulamin §5 pkt 10)."];
  return build(`Blachy Klubowe ${rok}: wyniki`, [
    `Procedura nadawania Blach Klubowych ${rok} zakończona. Rozpatrzone kandydatury: ${rozpatrzone}.`,
    ...(laureaci.length ? [`Wyróżnieni (${laureaci.length}):`] : []),
    ...lista,
    `Rejestr Blach: aplikacja → Klub → Blachy (${appUrl}). Uroczyste blachowanie ogłosimy osobno.`,
  ]);
}

export function mailRozpatrzona(rok: number, kandydat: string): Mail {
  return build(`Blachy Klubowe ${rok}: Twoje zgłoszenie zostało rozpatrzone`, [
    `Kapituła Blach rozpatrzyła zgłoszoną przez Ciebie kandydaturę: ${kandydat}. Wyniki procedury zostały ogłoszone na liście klubowej.`,
    "Zastrzeżenia dotyczące przestrzegania procedury możesz zgłosić Komisji Rewizyjnej w ciągu 14 dni (regulamin §6 pkt 5). KR ocenia wyłącznie zgodność procedury z regulaminem.",
  ]);
}
