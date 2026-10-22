import * as admin from "firebase-admin";
import {ServiceTask} from "../types";
import {getServiceConfig} from "../service_config";
import {GoogleSheetsProvider, buildLooseRowGetter} from "../providers/googleSheetsProvider";
import {BLACHY_COLLECTION, parseBlacha, splitSp} from "../../modules/blachy/blachy_registry";

type Payload = {spreadsheetId?: string; tabName?: string; dry?: boolean};

/**
 * Jednorazowy import blach sprzed aplikacji (regulamin § 6 pkt 8) z arkusza bilansu otwarcia
 * do rejestru `blachy`. Dokument `bo_<ID wiersza bilansu>`; istniejący wpis NIE jest nadpisywany
 * (poprawki zarządu w aplikacji zostają). Arkusz i zakładka podawane w payloadzie.
 */
export const blachyImportOpeningBalanceTask: ServiceTask<Payload> = {
  id: "blachy.importOpeningBalance",
  description: "Import blach z bilansu otwarcia do Rejestru Blach (kolekcja blachy). Nie nadpisuje istniejących wpisów.",
  validate: (p) => {
    if (!String(p?.spreadsheetId || "").trim()) throw new Error("payload.spreadsheetId wymagany");
    if (!String(p?.tabName || "").trim()) throw new Error("payload.tabName wymagany");
  },
  run: async (payload, ctx) => {
    const dry = ctx.dryRun || payload.dry === true;
    const cfg = getServiceConfig();
    const sheets = new GoogleSheetsProvider(cfg.workspace.delegatedSubject);
    const table = await sheets.readTableAsObjects({spreadsheetId: String(payload.spreadsheetId), tabName: String(payload.tabName)});
    const g = buildLooseRowGetter(table.headers);

    const items: Array<{id: string; osoba: string; rok: number | null; action: string}> = [];
    for (const row of table.rows) {
      const b = parseBlacha(g(row, "blacha"));
      if (!b.has) continue;
      const boId = String(g(row, "ID") || "").trim();
      if (!boId) {
        items.push({id: "", osoba: `${g(row, "Imię")} ${g(row, "Nazwisko")}`, rok: b.rok, action: "POMINIĘTE: brak ID w bilansie"});
        continue;
      }
      const id = `bo_${boId}`;
      const {imie, sp} = splitSp(g(row, "Imię"));
      const osoba = `${imie} ${g(row, "Nazwisko")}`.trim();
      const ref = ctx.firestore.collection(BLACHY_COLLECTION).doc(id);
      if ((await ref.get()).exists) {
        items.push({id, osoba, rok: b.rok, action: "jest w rejestrze"});
        continue;
      }
      if (!dry) {
        await ref.set({
          imie, nazwisko: g(row, "Nazwisko"), ksywa: g(row, "Ksywa"),
          rok: b.rok, nr: null, uzasadnienie: "", klub: "", zalozycielska: "", sp,
          email: String(g(row, "e-mail") || "").trim().toLowerCase(), memberId: null,
          zrodlo: "bilans_otwarcia", boId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: "blachy.importOpeningBalance",
        });
      }
      items.push({id, osoba, rok: b.rok, action: dry ? "do dodania" : "dodane"});
    }
    const added = items.filter((x) => x.action === "dodane" || x.action === "do dodania").length;
    return {ok: true, message: `Blachy z bilansu: ${items.length} osób, ${dry ? "do dodania" : "dodane"}: ${added}${dry ? " (dry)" : ""}`, details: {dry, items}};
  },
};
