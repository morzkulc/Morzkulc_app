import * as admin from "firebase-admin";
import {ServiceTask} from "../types";
import {GoogleSheetsProvider} from "../providers/googleSheetsProvider";
import {getServiceConfig} from "../service_config";
import {normNullish} from "../../modules/shared/text_utils";
import {normalizeSheetHeader} from "../../modules/kurs/kurs_zgloszenia";
import {isTestAccount} from "../../modules/setup/app_vars";

/**
 * members.updateProfileInSheet — po edycji własnych danych w profilu wpisuje do arkusza członków
 * (wiersz po ID) TYLKO komórki imię / nazwisko / telefon / data urodzenia. Celowo nie pełny upsert
 * (membersSyncToSheet nadpisałby też Rolę/Status, które Zarząd mógł właśnie zmienić w arkuszu).
 * Wartości czytane z bazy w chwili wykonania — kilka szybkich edycji = wygrywa ostatnia.
 */
export const membersUpdateProfileInSheetTask: ServiceTask<{uid: string}> = {
  id: "members.updateProfileInSheet",
  description: "Profil: zapis edytowanego imienia, nazwiska, telefonu i daty urodzenia do arkusza członków (wiersz po ID).",

  validate: (payload) => {
    if (!payload?.uid) throw new Error("Missing uid");
  },

  run: async (payload, ctx) => {
    const snap = await ctx.firestore.collection("users_active").doc(payload.uid).get();
    const u = snap.data() as any;
    if (!u) return {ok: true, message: "Konto nie istnieje — pominięte."};
    const memberId = String(u?.memberId || "");
    if (!memberId) return {ok: true, message: "Brak numeru członkowskiego — pominięte."};
    if (await isTestAccount(ctx.firestore, normNullish(u?.email))) return {ok: true, message: "Konto testowe — pominięte."};

    const cfg = getServiceConfig();
    const sheetCfg = {spreadsheetId: cfg.sheets.membersSpreadsheetId, tabName: cfg.sheets.membersTabName};
    const sheets = new GoogleSheetsProvider(cfg.workspace.delegatedSubject);
    const table = await sheets.readTableAsObjects(sheetCfg);
    const header = (norm: string) => table.headers.find((h) => normalizeSheetHeader(h) === norm) || "";
    const idH = header("id");
    const cols = {imie: header("imie"), nazwisko: header("nazwisko"), telefon: header("telefon"), dob: header("data_urodzenia")};
    if (!idH || !cols.imie || !cols.nazwisko || !cols.telefon || !cols.dob) {
      return {ok: false, message: "Arkusz członków: brak kolumny ID / imię / nazwisko / telefon / data urodzenia."};
    }
    const row = table.rows.find((r) => normNullish(r[idH]) === memberId);
    if (!row) return {ok: false, message: `Arkusz członków: brak wiersza z ID ${memberId}.`};

    const p = u.profile || {};
    const patch: Record<string, string> = {};
    if (normNullish(row[cols.imie]) !== normNullish(p.firstName)) patch[cols.imie] = normNullish(p.firstName);
    if (normNullish(row[cols.nazwisko]) !== normNullish(p.lastName)) patch[cols.nazwisko] = normNullish(p.lastName);
    if (normNullish(row[cols.telefon]) !== normNullish(p.phone)) patch[cols.telefon] = normNullish(p.phone);
    // W arkuszu data bywa jako DD.MM.RRRR (wyświetlana) — porównanie po ISO, zapis ISO jak przy rejestracji.
    const sheetDob = normNullish(row[cols.dob]).replace(/^(\d{2})\.(\d{2})\.(\d{4})$/, "$3-$2-$1");
    if (p.dateOfBirth && sheetDob !== normNullish(p.dateOfBirth)) patch[cols.dob] = normNullish(p.dateOfBirth);
    if (!Object.keys(patch).length) return {ok: true, message: `ID ${memberId}: arkusz już aktualny.`};
    if (ctx.dryRun) return {ok: true, message: `[DRY RUN] ID ${memberId}: ${Object.keys(patch).join(", ")}`};

    // RAW — telefon "+48 ..." / "0 ..." nie może zostać zamieniony przez arkusz na liczbę/formułę.
    await sheets.writeRowCells(sheetCfg, Number((row as any)._rowNumber), patch, "RAW");
    await snap.ref.update({"service.profileSheetSyncedAt": admin.firestore.FieldValue.serverTimestamp()});
    ctx.logger.info("members.updateProfileInSheet: done", {uid: payload.uid, memberId, fields: Object.keys(patch)});
    return {ok: true, message: `ID ${memberId}: zapisano ${Object.keys(patch).join(", ")}`};
  },
};
