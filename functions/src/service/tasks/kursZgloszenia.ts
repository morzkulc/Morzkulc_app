import * as admin from "firebase-admin";
import {ServiceTask, ServiceTaskContext} from "../types";
import {GoogleSheetsProvider} from "../providers/googleSheetsProvider";
import {getServiceConfig} from "../service_config";
import {roleLabel, statusLabel} from "./membersSyncToSheet";
import {ZGLOSZENIA_COLLECTION, resolveSheetHeaders} from "../../modules/kurs/kurs_zgloszenia";
import {loadKursSignupConfig, przelewInfo} from "../../modules/kurs/kurs_signup_config";
import {buildApplicantMail, buildPaymentMail} from "../../modules/kurs/kurs_zgloszenia_mail";
import {parseSchoolYear} from "../../modules/equipment/bundle/gear_bundle_service";

/**
 * Taski zapisów na kurs (formularz kurs.morzkulc.pl/zapis → kurs_zgloszenia).
 *
 *   kurs.notifyZgloszenie  — mail z danymi do przelewu + powiadomienie kontaktu kursu
 *   kurs.promoteToMembers  — zadatek wpłacony: wiersz w arkuszu członków (Rola=Kursant)
 *                            + members_roster od razu (dostęp do aplikacji bez czekania na sync)
 *   kurs.markPaid          — pełna wpłata: „Opłata za kurs” w arkuszu = cena
 *   kurs.removeKursant     — rezygnacja: osoba bez konta znika z arkusza i members_roster;
 *                            osoba z kontem wraca do poprzedniej roli
 *   kurs.purgeDemo         — koniec trybu demo: zgłoszenia demo:true znikają z bazy i arkusza
 *
 * Arkusz członków jest źródłem prawdy ról (usersSyncRolesFromSheet), więc wszystkie
 * zmiany roli idą przez arkusz, a zmianę w users_active robi istniejący sync ról.
 */

type Payload = {id: string};


const ROW_KEYS = [
  "id", "e_mail", "imie", "nazwisko", "telefon", "data_urodzenia", "rok_szkoleniowki",
  "rola", "status", "pesel", "waga", "wzrost", "oplata_za_kurs", "zgody_rodo",
];

function validateId(payload: Payload) {
  if (!payload?.id || typeof payload.id !== "string") throw new Error("Missing id");
}

async function loadZgloszenie(ctx: ServiceTaskContext, id: string) {
  const ref = ctx.firestore.collection(ZGLOSZENIA_COLLECTION).doc(id);
  const snap = await ref.get();
  return {ref, z: snap.exists ? (snap.data() as any) : null};
}

async function findUserByEmail(db: FirebaseFirestore.Firestore, email: string) {
  const q = await db.collection("users_active").where("email", "==", email).limit(1).get();
  return q.empty ? null : {uid: q.docs[0].id, data: q.docs[0].data() as any};
}

async function enqueue(db: FirebaseFirestore.Firestore, taskId: string, payload: Record<string, any>) {
  const ref = db.collection("service_jobs").doc();
  await ref.set({
    id: ref.id, taskId, payload, status: "queued", attempts: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

function membersCfg() {
  const cfg = getServiceConfig();
  return {
    sheets: new GoogleSheetsProvider(cfg.workspace.delegatedSubject),
    table: {spreadsheetId: cfg.sheets.membersSpreadsheetId, tabName: cfg.sheets.membersTabName},
  };
}

async function readMembers(sheets: GoogleSheetsProvider, table: {spreadsheetId: string; tabName: string}) {
  const t = await sheets.readTableAsObjects(table);
  const {map, missing} = resolveSheetHeaders(t.headers, ROW_KEYS);
  if (missing.length) {
    throw new Error(`Arkusz członków: brak kolumn ${missing.join(", ")}`);
  }
  const optH = resolveSheetHeaders(t.headers, ["dokument_tozsamosci"]).map;
  return {rows: t.rows as Array<Record<string, any>>, h: map, optH};
}

function rowsByEmail(rows: Array<Record<string, any>>, h: Record<string, string>, email: string) {
  return rows.filter((r) => String(r[h.e_mail] || "").trim().toLowerCase() === email);
}

/**
 * Nowy numer członka z licznika counters/members. Licznik podnosimy co najmniej do
 * max(ID w arkuszu)+1 — zarząd dopisuje czasem wiersze ręcznie, a zdublowany ID
 * scaliłby dwie osoby przy upsercie.
 */
async function allocateMemberId(db: FirebaseFirestore.Firestore, sheetMaxId: number): Promise<number> {
  const counterRef = db.collection("counters").doc("members");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const stored = snap.exists ? Number((snap.data() as any)?.nextId || 1) : 1;
    const id = Math.max(stored > 0 ? stored : 1, sheetMaxId + 1);
    tx.set(counterRef, {nextId: id + 1}, {merge: true});
    return id;
  });
}

async function roleMappings(db: FirebaseFirestore.Firestore) {
  const snap = await db.collection("setup").doc("app").get();
  const d = snap.exists ? (snap.data() as any) : null;
  return {roles: d?.roleMappings, statuses: d?.statusMappings};
}

export const kursNotifyZgloszenieTask: ServiceTask<Payload> = {
  id: "kurs.notifyZgloszenie",
  description: "Zgłoszenie na kurs: mail z danymi do przelewu do zgłaszającego + powiadomienie kontaktu kursu.",
  validate: validateId,
  run: async (payload, ctx) => {
    const {ref, z} = await loadZgloszenie(ctx, payload.id);
    if (!z) return {ok: true, message: "Zgłoszenie nie istnieje — pominięte"};
    const cfg = await loadKursSignupConfig(ctx.firestore);
    const name = `${z.form.imie} ${z.form.nazwisko}`;
    const sent: string[] = [];

    if (!z.notify?.applicantAt) {
      const mail = buildApplicantMail(z, cfg);
      await ctx.workspace.sendGenericEmailHtml(z.email, mail.subject, mail.text, mail.html);
      await ref.update({"notify.applicantAt": admin.firestore.FieldValue.serverTimestamp()});
      sent.push("applicant");
    }

    const staff = typeof cfg.kurs.kontaktEmail === "string" ? cfg.kurs.kontaktEmail : "";
    if (staff && !z.notify?.staffAt) {
      const text = [
        `Nowe zgłoszenie na Kurs ${z.edycja}: ${name}`,
        `E-mail: ${z.email}`,
        `Telefon: ${z.form.telefon}`,
        `Student: ${z.form.student ? `tak (${z.form.uczelnia})` : "nie"}`,
        "",
        "Lista zgłoszeń i potwierdzanie wpłat: aplikacja → Panel zarządu → Kurs.",
      ].join("\n");
      await ctx.workspace.sendGenericEmail(staff, `${z.demo ? "[TEST] " : ""}Nowe zgłoszenie na kurs: ${name}`, text);
      await ref.update({"notify.staffAt": admin.firestore.FieldValue.serverTimestamp()});
      sent.push("staff");
    }
    return {ok: true, message: sent.length ? `Wysłano: ${sent.join(", ")}` : "Nic do wysłania", details: {id: payload.id}};
  },
};

export const kursPromoteToMembersTask: ServiceTask<Payload> = {
  id: "kurs.promoteToMembers",
  description: "Zadatek wpłacony: kursant trafia do arkusza członków (Rola=Kursant) i members_roster — dostęp do aplikacji.",
  validate: validateId,
  run: async (payload, ctx) => {
    const db = ctx.firestore;
    const {ref, z} = await loadZgloszenie(ctx, payload.id);
    if (!z) return {ok: true, message: "Zgłoszenie nie istnieje — pominięte"};
    if (z.status !== "zadatek" && z.status !== "oplacony") {
      return {ok: true, message: `Status ${z.status} — pominięte`};
    }
    const cfg = await loadKursSignupConfig(db);
    const rok = parseSchoolYear(z.edycja);
    if (rok === null) throw new Error(`Nieprawidłowa edycja kursu: ${z.edycja}`);
    const p = przelewInfo(cfg, z);
    const oplata = z.status === "oplacony" ? p.cena : p.zadatek;
    if (!oplata) throw new Error("Brak kwoty opłaty (kurs_zadatek / cena_kursu w Vars_KURS)");

    const {sheets, table} = membersCfg();
    const {rows, h, optH} = await readMembers(sheets, table);
    const user = await findUserByEmail(db, z.email);

    let memberId = Number(z.memberId || 0);
    if (user && Number(user.data?.memberId) > 0) memberId = Number(user.data.memberId);
    const existingRow = rowsByEmail(rows, h, z.email)[0];
    if (!memberId && existingRow && Number(existingRow[h.id]) > 0) memberId = Number(existingRow[h.id]);
    if (!memberId) {
      const sheetMax = rows.reduce((m, r) => Math.max(m, Number(r[h.id]) || 0), 0);
      memberId = await allocateMemberId(db, sheetMax);
    }
    if (user && !(Number(user.data?.memberId) > 0)) {
      // Konto bez numeru (niepełny profil): ten sam numer co w arkuszu, żeby
      // membersSyncToSheet nie nadał drugiego.
      await db.collection("users_active").doc(user.uid).set({memberId}, {merge: true});
    }

    const labels = await roleMappings(db);
    const patch: Record<string, string> = {
      [h.id]: String(memberId),
      [h.e_mail]: z.email,
      [h.rola]: roleLabel("rola_kursant", labels.roles),
      [h.status]: statusLabel("status_aktywny", labels.statuses),
      [h.rok_szkoleniowki]: String(rok),
      [h.pesel]: z.form.pesel || "",
      [h.waga]: String(z.form.waga),
      [h.wzrost]: String(z.form.wzrost),
      [h.oplata_za_kurs]: String(oplata),
    };
    // Jak membersSyncToSheet: TAK, gdy obie zgody z rejestracji (RODO + statut) są zaznaczone.
    if (z.form.zgodaRodo && z.form.zgodaStatut) patch[h.zgody_rodo] = "TAK";
    if (!existingRow) {
      patch[h.imie] = z.form.imie;
      patch[h.nazwisko] = z.form.nazwisko;
      patch[h.telefon] = z.form.telefon;
      patch[h.data_urodzenia] = z.form.dataUrodzenia;
    }
    if (z.form.brakPesel) {
      // Bez PESEL sync kursanta wymaga numeru dokumentu w osobnej kolumnie.
      if (!optH.dokument_tozsamosci) throw new Error("Arkusz członków: brak kolumny „Dokument tożsamości” (kursant bez PESEL)");
      patch[optH.dokument_tozsamosci] = z.form.dokument;
    }
    const res = await sheets.upsertMemberRowById(table, patch);

    await db.collection("members_roster").doc(z.email).set({
      email: z.email,
      rola: "rola_kursant",
      status: "status_aktywny",
      rokSzkoleniowki: rok,
      memberId,
      updatedAt: new Date().toISOString(),
    });

    const update: Record<string, any> = {
      "memberId": memberId,
      "promotedAt": admin.firestore.FieldValue.serverTimestamp(),
      "sheet.rowNumber": res.rowNumber,
    };
    // Poprzednia rola (np. sympatyk) — do przywrócenia przy rezygnacji. Zapisujemy raz.
    if (user && z.previousRoleKey === undefined) {
      const prev = String(user.data?.role_key || "");
      update.previousRoleKey = prev && prev !== "rola_kursant" ? prev : "rola_sympatyk";
    }
    await ref.update(update);

    if (user && String(user.data?.role_key) !== "rola_kursant") {
      // Konto już istnieje: rolę w users_active (grupy, mail o zmianie roli) zmienia sync ról.
      await enqueue(db, "users.syncRolesFromSheet", {});
    }
    // Potwierdzenie wpłaty (zadatek albo od razu cały kurs) — raz na rodzaj.
    const kind = z.status === "oplacony" ? "oplacony" : "zadatek";
    const marker = kind === "oplacony" ? "paidAt" : "accessAt";
    if (!z.notify?.[marker]) {
      const mail = buildPaymentMail(z, cfg, kind, Boolean(user));
      await ctx.workspace.sendGenericEmailHtml(z.email, mail.subject, mail.text, mail.html);
      await ref.update({[`notify.${marker}`]: admin.firestore.FieldValue.serverTimestamp()});
    }

    return {ok: true, message: `Kursant w arkuszu (${res.action}, wiersz ${res.rowNumber}), ID ${memberId}`,
      details: {id: payload.id, memberId, existingUser: Boolean(user)}};
  },
};

export const kursMarkPaidTask: ServiceTask<Payload> = {
  id: "kurs.markPaid",
  description: "Pełna wpłata za kurs: „Opłata za kurs” w arkuszu członków = cena kursu.",
  validate: validateId,
  run: async (payload, ctx) => {
    const {ref, z} = await loadZgloszenie(ctx, payload.id);
    if (!z || z.status !== "oplacony") return {ok: true, message: "Brak zgłoszenia albo status inny niż oplacony — pominięte"};
    const cfg = await loadKursSignupConfig(ctx.firestore);
    const cena = przelewInfo(cfg, z).cena;
    if (!cena) throw new Error("Brak ceny kursu (cena_kursu w Vars_KURS)");
    const {sheets, table} = membersCfg();
    const {rows, h} = await readMembers(sheets, table);
    const row = rowsByEmail(rows, h, z.email)[0];
    if (!row) {
      // Wiersza jeszcze nie ma (np. pełna wpłata od razu) — przeniesienie zrobi go z pełną kwotą.
      await enqueue(ctx.firestore, "kurs.promoteToMembers", {id: payload.id});
      return {ok: true, message: "Brak wiersza — zlecono przeniesienie do arkusza"};
    }
    await sheets.writeRowCells(table, Number(row._rowNumber), {[h.oplata_za_kurs]: String(cena)});
    if (!z.notify?.paidAt) {
      const user = await findUserByEmail(ctx.firestore, z.email);
      const mail = buildPaymentMail(z, cfg, "oplacony", Boolean(user));
      await ctx.workspace.sendGenericEmailHtml(z.email, mail.subject, mail.text, mail.html);
      await ref.update({"notify.paidAt": admin.firestore.FieldValue.serverTimestamp()});
    }
    return {ok: true, message: `Opłata za kurs = ${cena} (wiersz ${row._rowNumber})`};
  },
};

/**
 * Wycofuje osobę z arkusza członków: bez konta — usuwa jej wiersze Kursant i members_roster;
 * z kontem — przywraca poprzednią rolę w arkuszu i zleca sync ról.
 */
async function removeFromMembers(ctx: ServiceTaskContext, z: any): Promise<string> {
  const db = ctx.firestore;
  const {sheets, table} = membersCfg();
  const {rows, h} = await readMembers(sheets, table);
  const labels = await roleMappings(db);
  const kursantLabel = roleLabel("rola_kursant", labels.roles).toLowerCase();
  // Tylko wiersze tej osoby z rolą Kursant — nigdy nie ruszamy członka, który już
  // ma inną rolę (np. zarząd zmienił ją ręcznie).
  const mine = rowsByEmail(rows, h, z.email)
    .filter((r) => String(r[h.rola] || "").trim().toLowerCase() === kursantLabel);
  const user = await findUserByEmail(db, z.email);

  if (!user) {
    if (mine.length) await sheets.deleteRows(table, mine.map((r) => Number(r._rowNumber)));
    await db.collection("members_roster").doc(z.email).delete();
    return "deleted";
  }

  const prevKey = String(z.previousRoleKey || "rola_sympatyk");
  for (const r of mine) {
    await sheets.writeRowCells(table, Number(r._rowNumber), {[h.rola]: roleLabel(prevKey, labels.roles)});
  }
  await db.collection("members_roster").doc(z.email).set({rola: prevKey, updatedAt: new Date().toISOString()}, {merge: true});
  if (mine.length) await enqueue(db, "users.syncRolesFromSheet", {});
  return `role:${prevKey}`;
}

export const kursRemoveKursantTask: ServiceTask<Payload> = {
  id: "kurs.removeKursant",
  description: "Rezygnacja z kursu: bez konta — usunięcie z arkusza członków i members_roster; z kontem — powrót do poprzedniej roli.",
  validate: validateId,
  run: async (payload, ctx) => {
    const {ref, z} = await loadZgloszenie(ctx, payload.id);
    if (!z || z.status !== "rezygnacja") return {ok: true, message: "Brak zgłoszenia albo status inny niż rezygnacja — pominięte"};
    const removal = await removeFromMembers(ctx, z);
    await ref.update({removedAt: admin.firestore.FieldValue.serverTimestamp(), removal});
    return {ok: true, message: removal === "deleted" ? "Usunięto z arkusza i members_roster" : `Konto istnieje — ${removal}`};
  },
};

// Usuwanie konta Firebase Auth — podmienialne w testach (fake Firestore nie ma Auth).
let deleteAuthUser = (uid: string) => admin.auth().deleteUser(uid);
export function setAuthUserDeleterForTests(fn: (uid: string) => Promise<void>) {
  deleteAuthUser = fn;
}

// Aktywność konta w aplikacji: konto z takimi danymi NIE jest kasowane automatycznie
// (usunięcie zostawiłoby np. zajęte miejsce na basenie albo rezerwację bez właściciela).
const ACTIVITY: Array<[string, string]> = [
  ["gear_reservations", "userUid"],
  ["basen_enrollments", "userUid"],
  ["basen_godziny_ledger", "uid"],
  ["godzinki_ledger", "uid"],
  ["km_logs", "uid"],
];

async function accountActivity(db: FirebaseFirestore.Firestore, uid: string): Promise<string[]> {
  const found: string[] = [];
  for (const [col, field] of ACTIVITY) {
    const q = await db.collection(col).where(field, "==", uid).limit(1).get();
    if (!q.empty) found.push(col);
  }
  return found;
}

/** Konto testera: wiersze tej osoby w arkuszu (Kursant albo numer z demo), members_roster, users_active, Auth. */
async function deleteTesterAccount(ctx: ServiceTaskContext, z: any, uid: string): Promise<void> {
  const db = ctx.firestore;
  const {sheets, table} = membersCfg();
  const {rows, h} = await readMembers(sheets, table);
  const labels = await roleMappings(db);
  const kursantLabel = roleLabel("rola_kursant", labels.roles).toLowerCase();
  const mine = rowsByEmail(rows, h, z.email).filter((r) =>
    String(r[h.rola] || "").trim().toLowerCase() === kursantLabel ||
    (z.memberId && String(r[h.id]) === String(z.memberId)));
  if (mine.length) await sheets.deleteRows(table, mine.map((r) => Number(r._rowNumber)));
  await db.collection("members_roster").doc(z.email).delete();
  await db.collection("users_active").doc(uid).delete();
  try {
    await deleteAuthUser(uid);
  } catch (e: any) {
    if (e?.code !== "auth/user-not-found") throw e;
  }
}

/**
 * Koniec trybu demo zapisów. Dla każdego zgłoszenia demo:true:
 *  - konto testera w aplikacji założone PO zgłoszeniu i bez aktywności (rezerwacje,
 *    baseny, godzinki, km) → usunięte całkowicie (arkusz, members_roster, users_active, Auth);
 *  - konto z aktywnością albo starsze niż zgłoszenie → tylko wycofanie z arkusza
 *    (jak rezygnacja) i pozycja w raporcie do ręcznej decyzji;
 *  - bez konta → wycofanie z arkusza i members_roster;
 *  - samo zgłoszenie → usunięte.
 * {dry: true} tylko raportuje.
 */
export const kursPurgeDemoTask: ServiceTask<{dry?: boolean}> = {
  id: "kurs.purgeDemo",
  description: "Usuwa zgłoszenia testowe (demo) z kurs_zgloszenia i arkusza członków oraz konta testerów bez aktywności. Payload {dry:true} = tylko raport.",
  validate: () => undefined,
  run: async (payload, ctx) => {
    const db = ctx.firestore;
    const dry = ctx.dryRun || payload?.dry === true;
    const snap = await db.collection(ZGLOSZENIA_COLLECTION).where("demo", "==", true).get();
    const report: Array<Record<string, any>> = [];
    for (const d of snap.docs) {
      const z = d.data() as any;
      const promoted = Boolean(z.memberId || z.promotedAt);
      const user = await findUserByEmail(db, z.email);
      const item: Record<string, any> = {id: d.id, email: z.email, status: z.status, promoted, hasAppAccount: Boolean(user)};
      let action = promoted ? "wycofanie z arkusza" : "tylko zgłoszenie";
      if (user) {
        const createdMs = user.data?.createdAt?.toMillis ? user.data.createdAt.toMillis() : 0;
        const zMs = z.createdAt?.toMillis ? z.createdAt.toMillis() : 0;
        const activity = await accountActivity(db, user.uid);
        item.activity = activity;
        if (createdMs >= zMs && !activity.length) action = "usunięcie konta";
        else action = activity.length ? "RĘCZNIE: konto ma aktywność" : "RĘCZNIE: konto starsze niż zgłoszenie";
      }
      item.action = action;
      if (!dry) {
        if (action === "usunięcie konta" && user) await deleteTesterAccount(ctx, z, user.uid);
        else if (promoted && !z.removedAt) await removeFromMembers(ctx, z);
        await d.ref.delete();
      }
      report.push(item);
    }
    const manual = report.filter((x) => String(x.action).startsWith("RĘCZNIE")).length;
    return {ok: true, message: `${dry ? "DRY: " : ""}zgłoszeń demo: ${report.length}, do ręcznej decyzji: ${manual}`,
      details: {dry, items: report}};
  },
};
