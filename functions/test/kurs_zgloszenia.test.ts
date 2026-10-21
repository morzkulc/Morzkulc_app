/**
 * Zapisy na kurs (kurs.morzkulc.pl/zapis): walidacja formularza, lista główna/rezerwowa,
 * endpoint strony (CORS, zamknięte zapisy, duplikat), akcje panelu oraz taski
 * przeniesienia do arkusza członków i rezygnacji (na fałszywym arkuszu).
 */
import {describe, it, expect, vi, beforeEach} from "vitest";
import {FakeFirestore, FakeTimestamp} from "./helpers/fake_firestore";

// Fałszywy arkusz członków — taski tworzą provider samodzielnie (new GoogleSheetsProvider).
const sheet = {headers: [] as string[], rows: [] as Array<Record<string, string>>, deleted: [] as number[]};
vi.mock("../src/service/providers/googleSheetsProvider", () => ({
  GoogleSheetsProvider: class {
    async readTableAsObjects() {
      return {headers: sheet.headers, rows: sheet.rows.map((r, i) => ({...r, _rowNumber: String(i + 2)}))};
    }
    async upsertMemberRowById(_cfg: any, patch: Record<string, string>) {
      const idH = sheet.headers.find((h) => h === "ID") as string;
      let i = sheet.rows.findIndex((r) => r[idH] === patch[idH]);
      if (i < 0) i = sheet.rows.findIndex((r) => (r["e-mail"] || "").toLowerCase() === (patch["e-mail"] || "").toLowerCase());
      if (i < 0) {
        sheet.rows.push({...patch});
        return {action: "appended", rowNumber: sheet.rows.length + 1};
      }
      sheet.rows[i] = {...sheet.rows[i], ...patch};
      return {action: "updated", rowNumber: i + 2};
    }
    async writeRowCells(_cfg: any, row: number, patch: Record<string, string>) {
      sheet.rows[row - 2] = {...sheet.rows[row - 2], ...patch};
    }
    async deleteRows(_cfg: any, rows: number[]) {
      sheet.deleted.push(...rows);
      for (const r of [...rows].sort((a, b) => b - a)) sheet.rows.splice(r - 2, 1);
    }
  },
}));

import {
  isValidPesel, validateZgloszenie, computeListy, resolveSheetHeaders, przelewTitle, cenaFor, isAdult,
} from "../src/modules/kurs/kurs_zgloszenia";
import {handleKursZgloszenie} from "../src/api/kursZgloszenieHandler";
import {buildApplicantMail} from "../src/modules/kurs/kurs_zgloszenia_mail";
import {handleAdminKursZgloszenieAction} from "../src/api/adminKursZgloszeniaHandler";
import {
  kursPromoteToMembersTask, kursRemoveKursantTask, kursNotifyZgloszenieTask, kursMarkPaidTask, kursPurgeDemoTask,
  setAuthUserDeleterForTests,
} from "../src/service/tasks/kursZgloszenia";

const PESEL = "44051401359";
const TODAY = "2026-10-21";

function validBody(over: Record<string, any> = {}) {
  return {
    imie: "Ala", nazwisko: "Kot", telefon: "500 600 700", dataUrodzenia: "1944-05-14", miejscowosc: "Gdańsk",
    pesel: PESEL, iceImie: "Ola Kot", iceTelefon: "600700800",
    doswiadczenie: "Nigdy", plywanie: "Dobra", sporty: "bieganie",
    chorobyPrzewlekle: false, leki: false, schorzenia: ["Żadne z powyższych"],
    wzrost: 170, waga: "65,5", student: true, uczelnia: "PG", dieta: "wszystko",
    zainteresowania: ["Wyprawy", "nieznane"], skad: "Instagram",
    zgodaRegulamin: true, zgodaZdrowie: true, zgodaWizerunek: false,
    ...over,
  };
}

describe("walidacja formularza", () => {
  it("PESEL: cyfra kontrolna", () => {
    expect(isValidPesel(PESEL)).toBe(true);
    expect(isValidPesel("44051401358")).toBe(false);
    expect(isValidPesel("4405140135")).toBe(false);
  });

  it("pełnoletność; data urodzenia niezależna od PESEL", () => {
    expect(isAdult("2008-10-21", TODAY)).toBe(true);
    expect(isAdult("2008-10-22", TODAY)).toBe(false);
    const minor = validateZgloszenie(validBody({dataUrodzenia: "2010-01-01"}), TODAY);
    expect(!minor.ok && minor.fields.dataUrodzenia).toBe("Kurs jest tylko dla osób pełnoletnich");
    expect(validateZgloszenie(validBody({dataUrodzenia: "1990-01-01"}), TODAY).ok).toBe(true);
  });

  it("brak PESEL: wymagany numer dokumentu, PESEL pomijany", () => {
    const bad = validateZgloszenie(validBody({brakPesel: true, pesel: "123", dokument: ""}), TODAY);
    expect(!bad.ok && Object.keys(bad.fields)).toEqual(["dokument"]);
    const ok = validateZgloszenie(validBody({brakPesel: true, pesel: "123", dokument: "AB 123456"}), TODAY);
    expect(ok.ok && [ok.data.pesel, ok.data.dokument]).toEqual(["", "AB 123456"]);
  });

  it("poprawny formularz → znormalizowane dane", () => {
    const v = validateZgloszenie(validBody(), TODAY);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.data.waga).toBe(65.5);
    expect(v.data.zainteresowania).toEqual(["Wyprawy"]);
    expect(v.data.zgodaWizerunek).toBe(false);
  });

  it("pola warunkowe, zakresy i zgody", () => {
    const v = validateZgloszenie(validBody({
      pesel: "123", chorobyPrzewlekle: true, chorobyOpis: "", student: true, uczelnia: "",
      waga: 20, zgodaRegulamin: false, dieta: "",
    }), TODAY);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(Object.keys(v.fields).sort()).toEqual(["chorobyOpis", "dieta", "pesel", "uczelnia", "waga", "zgodaRegulamin"]);
  });

  it("„Żadne z powyższych” znika przy innych schorzeniach", () => {
    const v = validateZgloszenie(validBody({schorzenia: ["Astma", "Żadne z powyższych"]}), TODAY);
    expect(v.ok && v.data.schorzenia).toEqual(["Astma"]);
  });

  it("tytuł przelewu i cena studencka", () => {
    expect(przelewTitle("2027", "Ala", "Kot")).toBe("Kurs 2027 – Ala Kot");
    expect(cenaFor(true, 2300, 2000)).toBe(2000);
    expect(cenaFor(true, 2300, null)).toBe(2300);
    expect(cenaFor(false, 2300, 2000)).toBe(2300);
  });
});

describe("lista główna / rezerwowa", () => {
  it("najpierw wpłacone wg daty zadatku, potem reszta wg zgłoszenia; rezygnacje poza listą", () => {
    const m = computeListy([
      {id: "a", status: "nowe", createdAtMs: 1, zadatekAtMs: null},
      {id: "b", status: "zadatek", createdAtMs: 2, zadatekAtMs: 50},
      {id: "c", status: "oplacony", createdAtMs: 3, zadatekAtMs: 10},
      {id: "d", status: "rezygnacja", createdAtMs: 0, zadatekAtMs: 5},
    ], 2);
    expect(m.get("c")).toEqual({pozycja: 1, lista: "glowna"});
    expect(m.get("b")).toEqual({pozycja: 2, lista: "glowna"});
    expect(m.get("a")).toEqual({pozycja: 3, lista: "rezerwowa"});
    expect(m.has("d")).toBe(false);
  });

  it("nagłówki arkusza dopasowane jak w syncu (polskie znaki, spacje)", () => {
    const r = resolveSheetHeaders(["ID", "e-mail", "rok szkoleniówki", "Opłata za kurs"], ["id", "e_mail", "rok_szkoleniowki", "oplata_za_kurs", "pesel"]);
    expect(r.map).toEqual({"id": "ID", "e_mail": "e-mail", "rok_szkoleniowki": "rok szkoleniówki", "oplata_za_kurs": "Opłata za kurs"});
    expect(r.missing).toEqual(["pesel"]);
  });
});

function kursVars(status = "otwarte", demoDo = "") {
  return {
    kurs_zapisy_demo_do: {value: demoDo},
    kurs_edycja: {value: 2027}, cena_kursu: {value: 2300}, kurs_zadatek: {value: 950},
    kurs_zapisy_status: {value: status}, kurs_termin_doplaty: {value: "2027-03-01"},
    kurs_kontakt_email: {value: "kurs@morzkulc.pl"},
  };
}

function seedDb(extra: Record<string, any[]> = {}, status = "otwarte", demoDo = "") {
  return new FakeFirestore({
    setup: [
      {_docId: "vars_kurs", vars: kursVars(status, demoDo)},
      {_docId: "vars_members", vars: {konto_klubowe: {value: "12 3456"}, bank_klubowy: {value: "mBank"}}},
      {_docId: "app", roleMappings: {rola_kursant: {label: "Kursant"}, rola_sympatyk: {label: "Sympatyk"}}, statusMappings: {status_aktywny: {label: "Aktywny"}}},
    ],
    ...extra,
  });
}

function mkRes() {
  const out: {status: number; body: any; headers: Record<string, string>} = {status: 0, body: null, headers: {}};
  const res: any = {
    setHeader: (k: string, v: string) => {
      out.headers[k] = v;
    },
    status: (s: number) => {
      out.status = s;
      return res;
    },
    json: (b: any) => {
      out.body = b;
      return res;
    },
    send: (b: any) => {
      out.body = b;
      return res;
    },
  };
  return {res, out};
}

async function callZapis(db: FakeFirestore, method: string, body: any = {}, origin = "https://kurs.morzkulc.pl") {
  const {res, out} = mkRes();
  await handleKursZgloszenie({method, headers: {origin}, body} as any, res, {
    db: db as any,
    requireAllowedHost: () => true,
    requireIdToken: async () => ({decoded: {uid: "u1", email: "Ala@Gmail.com", email_verified: true}}),
  });
  return out;
}

describe("POST/GET /api/kurs/zgloszenie", () => {
  it("obcy origin → 403, preflight z kursu → 204 z ACAO", async () => {
    expect((await callZapis(seedDb(), "GET", {}, "https://evil.example")).status).toBe(403);
    const pre = await callZapis(seedDb(), "OPTIONS");
    expect(pre.status).toBe(204);
    expect(pre.headers["Access-Control-Allow-Origin"]).toBe("https://kurs.morzkulc.pl");
  });

  it("zgłoszenie: dokument + job maila; drugie → 409; GET zwraca dane do przelewu", async () => {
    const db = seedDb();
    const r = await callZapis(db, "POST", validBody());
    expect(r.status).toBe(200);
    const docs = db.dump("kurs_zgloszenia");
    expect(docs).toHaveLength(1);
    expect((await db.collection("kurs_zgloszenia").doc("2027_ala@gmail.com").get()).exists).toBe(true);
    expect(db.dump("service_jobs").map((j: any) => j.taskId)).toEqual(["kurs.notifyZgloszenie"]);
    expect((await callZapis(db, "POST", validBody())).status).toBe(409);
    const g = await callZapis(db, "GET");
    expect(g.body.zgloszenie.przelew).toMatchObject({konto: "12 3456", bank: "mBank", zadatek: 950, cena: 2300, tytul: "Kurs 2027 – Ala Kot"});
  });

  it("tryb demo: formularz otwarty mimo statusu wkrotce, zgłoszenie oznaczone demo", async () => {
    const db = seedDb({}, "wkrotce", "2099-12-31");
    const r = await callZapis(db, "POST", validBody());
    expect(r.status).toBe(200);
    expect(r.body.kurs.demo).toBe(true);
    expect(db.dump("kurs_zgloszenia")[0].demo).toBe(true);
    expect((await callZapis(seedDb({}, "wkrotce", "2000-01-01"), "POST", validBody())).body.code).toBe("zapisy_closed");
  });

  it("konto w aplikacji: demo blokuje każde, prawdziwe zapisy tylko inne niż sympatyk", async () => {
    const member = {users_active: [{_docId: "u1", email: "ala@gmail.com", role_key: "rola_czlonek"}]};
    const symp = {users_active: [{_docId: "u1", email: "ala@gmail.com", role_key: "rola_sympatyk"}]};
    const demoSymp = seedDb(symp, "wkrotce", "2099-12-31");
    expect((await callZapis(demoSymp, "GET")).body.blokada).toBeTruthy();
    expect((await callZapis(demoSymp, "POST", validBody())).body.code).toBe("account_blocked");
    expect((await callZapis(seedDb(member), "POST", validBody())).body.code).toBe("account_blocked");
    expect((await callZapis(seedDb(symp), "POST", validBody())).status).toBe(200);
  });

  it("zapisy zamknięte → 409, błędne pola → 400", async () => {
    expect((await callZapis(seedDb({}, "wkrotce"), "POST", validBody())).body.code).toBe("zapisy_closed");
    const bad = await callZapis(seedDb(), "POST", validBody({pesel: "1"}));
    expect(bad.status).toBe(400);
    expect(bad.body.fields.pesel).toBeTruthy();
  });
});

function zgl(status: string, over: Record<string, any> = {}) {
  const v = validateZgloszenie(validBody(), TODAY);
  return {_docId: "2027_ala@gmail.com", edycja: "2027", email: "ala@gmail.com", status,
    form: v.ok ? v.data : {}, createdAt: new FakeTimestamp(new Date()), ...over};
}

async function callAction(db: FakeFirestore, action: string) {
  const {res, out} = mkRes();
  let pending: Promise<void> = Promise.resolve();
  await handleAdminKursZgloszenieAction({method: "POST", headers: {}, body: {id: "2027_ala@gmail.com", action}} as any, res, {
    db: db as any, sendPreflight: () => false, requireAllowedHost: () => true, setCorsHeaders: () => undefined,
    corsHandler: (_q: any, _s: any, fn: any) => {
      pending = fn();
    },
    requireIdToken: async () => ({decoded: {uid: "adm", email: "zarzad@morzkulc.pl"}}),
    adminRoleKeys: ["rola_zarzad"],
  });
  await pending;
  return out;
}

describe("akcje panelu", () => {
  const admins = {users_active: [{_docId: "adm", email: "zarzad@morzkulc.pl", role_key: "rola_zarzad"}]};

  it("zadatek → status + job przeniesienia; ponowny zadatek → 409", async () => {
    const db = seedDb({...admins, kurs_zgloszenia: [zgl("nowe")]});
    expect((await callAction(db, "zadatek")).status).toBe(200);
    expect(db.dump("kurs_zgloszenia")[0].status).toBe("zadatek");
    expect(db.dump("service_jobs").map((j: any) => j.taskId)).toEqual(["kurs.promoteToMembers"]);
    expect((await callAction(db, "zadatek")).status).toBe(409);
  });

  it("rezygnacja przed wpłatą nie zleca sprzątania", async () => {
    const db = seedDb({...admins, kurs_zgloszenia: [zgl("nowe")]});
    expect((await callAction(db, "rezygnacja")).status).toBe(200);
    expect(db.dump("service_jobs")).toHaveLength(0);
  });

  it("bez roli admina → 403", async () => {
    const db = seedDb({users_active: [{_docId: "adm", role_key: "rola_czlonek"}], kurs_zgloszenia: [zgl("nowe")]});
    expect((await callAction(db, "zadatek")).status).toBe(403);
  });
});

const HEADERS = ["ID", "e-mail", "imię", "nazwisko", "telefon", "data urodzenia", "rok szkoleniówki", "Rola", "Status", "PESEL", "Waga", "Wzrost", "Opłata za kurs", "Dokument tożsamości"];

function ctx(db: FakeFirestore) {
  const mails: Array<{to: string; subject: string}> = [];
  const workspace: any = {
    sendGenericEmailHtml: async (to: string, subject: string) => {
      mails.push({to, subject});
    },
    sendGenericEmail: async (to: string, subject: string) => {
      mails.push({to, subject});
    },
  };
  const logger = {info: () => undefined, warn: () => undefined, error: () => undefined};
  return {c: {firestore: db as any, now: new Date(), dryRun: false, workspace, config: {} as any, logger}, mails};
}

describe("taski: przeniesienie i rezygnacja", () => {
  beforeEach(() => {
    sheet.headers = HEADERS;
    sheet.rows = [{"ID": "40", "e-mail": "inny@x.pl", "Rola": "Członek"}];
    sheet.deleted = [];
  });

  it("nowa osoba: ID > max w arkuszu, wiersz Kursant, members_roster, mail o dostępie", async () => {
    const db = seedDb({kurs_zgloszenia: [zgl("zadatek")], counters: [{_docId: "members", nextId: 12}]});
    const {c, mails} = ctx(db);
    const r = await kursPromoteToMembersTask.run({id: "2027_ala@gmail.com"}, c);
    expect(r.ok).toBe(true);
    const row = sheet.rows.find((x) => x["e-mail"] === "ala@gmail.com") as any;
    expect(row).toMatchObject({"ID": "41", "Rola": "Kursant", "Status": "Aktywny", "rok szkoleniówki": "2027",
      "PESEL": PESEL, "Waga": "65.5", "Opłata za kurs": "950", "imię": "Ala"});
    expect(db.dump("members_roster")[0]).toMatchObject({email: "ala@gmail.com", rola: "rola_kursant", rokSzkoleniowki: 2027, memberId: 41});
    expect(db.dump("counters")[0].nextId).toBe(42);
    expect(mails.map((m) => m.to)).toEqual(["ala@gmail.com"]);
  });

  it("kursant bez PESEL: numer dokumentu w kolumnie „Dokument tożsamości”, PESEL pusty", async () => {
    const z = zgl("zadatek");
    z.form = {...z.form, pesel: "", brakPesel: true, dokument: "AB 123456"};
    const db = seedDb({kurs_zgloszenia: [z]});
    await kursPromoteToMembersTask.run({id: "2027_ala@gmail.com"}, ctx(db).c);
    const row = sheet.rows.find((x) => x["e-mail"] === "ala@gmail.com") as any;
    expect([row["PESEL"], row["Dokument tożsamości"]]).toEqual(["", "AB 123456"]);
  });

  it("pełna wpłata aktualizuje opłatę w wierszu", async () => {
    sheet.rows.push({"ID": "41", "e-mail": "ala@gmail.com", "Rola": "Kursant", "Opłata za kurs": "950"});
    const db = seedDb({kurs_zgloszenia: [zgl("oplacony")]});
    await kursMarkPaidTask.run({id: "2027_ala@gmail.com"}, ctx(db).c);
    expect(sheet.rows[1]["Opłata za kurs"]).toBe("2300");
  });

  it("rezygnacja bez konta: wiersz i members_roster usunięte, cudzy wiersz nietknięty", async () => {
    sheet.rows.push({"ID": "41", "e-mail": "ala@gmail.com", "Rola": "Kursant"});
    const db = seedDb({kurs_zgloszenia: [zgl("rezygnacja", {memberId: 41})],
      members_roster: [{_docId: "ala@gmail.com", email: "ala@gmail.com", rola: "rola_kursant"}]});
    await kursRemoveKursantTask.run({id: "2027_ala@gmail.com"}, ctx(db).c);
    expect(sheet.deleted).toEqual([3]);
    expect(sheet.rows.map((x) => x["e-mail"])).toEqual(["inny@x.pl"]);
    expect(db.dump("members_roster")).toHaveLength(0);
  });

  it("rezygnacja z kontem: rola wraca do poprzedniej + sync ról", async () => {
    sheet.rows.push({"ID": "7", "e-mail": "ala@gmail.com", "Rola": "Kursant"});
    const db = seedDb({
      kurs_zgloszenia: [zgl("rezygnacja", {memberId: 7, previousRoleKey: "rola_sympatyk"})],
      users_active: [{_docId: "u1", email: "ala@gmail.com", role_key: "rola_kursant", memberId: 7}],
      members_roster: [{_docId: "ala@gmail.com", rola: "rola_kursant"}],
    });
    await kursRemoveKursantTask.run({id: "2027_ala@gmail.com"}, ctx(db).c);
    expect(sheet.rows[1]["Rola"]).toBe("Sympatyk");
    expect(db.dump("members_roster")[0].rola).toBe("rola_sympatyk");
    expect(db.dump("service_jobs").map((j: any) => j.taskId)).toEqual(["users.syncRolesFromSheet"]);
  });

  it("osoba z kontem: użyty jej numer, zapamiętana poprzednia rola, bez maila o dostępie", async () => {
    sheet.rows.push({"ID": "7", "e-mail": "ala@gmail.com", "Rola": "Sympatyk", "imię": "Alicja"});
    const db = seedDb({kurs_zgloszenia: [zgl("zadatek")],
      users_active: [{_docId: "u1", email: "ala@gmail.com", role_key: "rola_sympatyk", memberId: 7}]});
    const {c, mails} = ctx(db);
    await kursPromoteToMembersTask.run({id: "2027_ala@gmail.com"}, c);
    expect(sheet.rows[1]).toMatchObject({"ID": "7", "Rola": "Kursant", "imię": "Alicja"});
    expect(db.dump("kurs_zgloszenia")[0].previousRoleKey).toBe("rola_sympatyk");
    expect(db.dump("service_jobs").map((j: any) => j.taskId)).toEqual(["users.syncRolesFromSheet"]);
    expect(mails).toHaveLength(0);
  });

  it("purge demo: wycofuje z arkusza i kasuje tylko zgłoszenia demo; dry nic nie zmienia", async () => {
    sheet.rows.push({"ID": "41", "e-mail": "ala@gmail.com", "Rola": "Kursant"});
    const db = seedDb({kurs_zgloszenia: [
      zgl("zadatek", {demo: true, memberId: 41}),
      {...zgl("nowe"), _docId: "2027_real@x.pl", email: "real@x.pl"},
    ], members_roster: [{_docId: "ala@gmail.com", rola: "rola_kursant"}]});
    const dry = await kursPurgeDemoTask.run({dry: true}, ctx(db).c);
    expect((dry.details as any).items).toHaveLength(1);
    expect(db.dump("kurs_zgloszenia")).toHaveLength(2);
    await kursPurgeDemoTask.run({}, ctx(db).c);
    expect(db.dump("kurs_zgloszenia").map((z: any) => z.email)).toEqual(["real@x.pl"]);
    expect(sheet.rows.map((x) => x["e-mail"])).toEqual(["inny@x.pl"]);
    expect(db.dump("members_roster")).toHaveLength(0);
  });

  it("purge demo: konto testera bez aktywności usunięte całkowicie, z aktywnością tylko raport", async () => {
    const deletedAuth: string[] = [];
    setAuthUserDeleterForTests(async (uid) => {
      deletedAuth.push(uid);
    });
    const old = new FakeTimestamp(new Date("2026-10-21T10:00:00Z"));
    const later = new FakeTimestamp(new Date("2026-10-22T10:00:00Z"));
    sheet.rows.push({"ID": "41", "e-mail": "ala@gmail.com", "Rola": "Kursant"});
    sheet.rows.push({"ID": "42", "e-mail": "bob@x.pl", "Rola": "Kursant"});
    const db = seedDb({
      kurs_zgloszenia: [
        zgl("zadatek", {demo: true, memberId: 41, createdAt: old}),
        {...zgl("zadatek", {demo: true, memberId: 42, createdAt: old}), _docId: "2027_bob@x.pl", email: "bob@x.pl"},
      ],
      users_active: [
        {_docId: "u1", email: "ala@gmail.com", role_key: "rola_kursant", createdAt: later},
        {_docId: "u2", email: "bob@x.pl", role_key: "rola_kursant", createdAt: later},
      ],
      km_logs: [{_docId: "k1", uid: "u2"}],
    });
    const dry = await kursPurgeDemoTask.run({dry: true}, ctx(db).c);
    expect((dry.details as any).items.map((x: any) => x.action)).toEqual(["usunięcie konta", "RĘCZNIE: konto ma aktywność"]);
    await kursPurgeDemoTask.run({}, ctx(db).c);
    expect(deletedAuth).toEqual(["u1"]);
    expect(db.dump("users_active").map((u: any) => u.email)).toEqual(["bob@x.pl"]);
    expect(sheet.rows.find((r) => r["e-mail"] === "ala@gmail.com")).toBeUndefined();
    expect(sheet.rows.find((r) => r["e-mail"] === "bob@x.pl")?.Rola).toBe("Sympatyk");
    expect(db.dump("kurs_zgloszenia")).toHaveLength(0);
  });

  it("mail zgłoszeniowy: kroki, dane do przelewu, baseny do wyboru, harmonogram, linki", () => {
    const cfg: any = {
      konto: "12 3456", bank: "mBank", appUrl: "https://app.morzkulc.pl/", kursUrl: "https://kurs.morzkulc.pl",
      kurs: {edycja: "2027", cena: 2300, zadatek: 950, terminDoplaty: "2027-03-01", minBasenow: 1, basenyWCenie: 2,
        kontaktEmail: "kurs@morzkulc.pl", harmonogram: [
          {from: "2027-03-04", to: "", type: "spotkanie", name: "Spotkanie organizacyjne", place: ""},
          {from: "2027-04-06", to: "", type: "basen", name: "Basen 1", place: ""},
          {from: "2027-04-24", to: "2027-04-25", type: "wyjazd", name: "Wyjazd I", place: "Ostrzyce"},
        ]},
    };
    const m = buildApplicantMail(zgl("nowe", {demo: true}), cfg);
    expect(m.subject).toMatch(/^\[TEST\] /);
    for (const frag of ["12 3456", "Kurs 2027 – Ala Kot", "950 zł", "1 marca 2027", "wybierasz 1–2 z 1 terminu",
      "HARMONOGRAM KURSU 2027", "24–25 kwietnia — wyjazd: Wyjazd I (Ostrzyce)", "6 kwietnia — basen (do wyboru): Basen 1",
      "https://kurs.morzkulc.pl/regulamin", "kurs@morzkulc.pl", "ala@gmail.com"]) {
      expect(m.text).toContain(frag);
    }
    expect(m.html).toContain("Harmonogram kursu 2027");
  });

  it("mail zgłoszeniowy: do zgłaszającego i kontaktu kursu, tylko raz", async () => {
    const db = seedDb({kurs_zgloszenia: [zgl("nowe")]});
    const {c, mails} = ctx(db);
    await kursNotifyZgloszenieTask.run({id: "2027_ala@gmail.com"}, c);
    await kursNotifyZgloszenieTask.run({id: "2027_ala@gmail.com"}, c);
    expect(mails.map((m) => m.to)).toEqual(["ala@gmail.com", "kurs@morzkulc.pl"]);
  });
});
