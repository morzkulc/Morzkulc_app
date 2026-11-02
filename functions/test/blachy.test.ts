/**
 * Rejestr Blach: parsowanie kolumny „blacha", archiwum klubowe do 2025 (bez edycji), sync arkusza członków
 * (tylko dopisuje, nigdy nie kasuje, nic do 2025), endpoint zarządu i lista w /api/klub (bez e-maili).
 */
import {describe, it, expect, vi, beforeEach} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";

const sheet = {headers: [] as string[], rows: [] as Array<Record<string, string>>};
vi.mock("../src/service/providers/googleSheetsProvider", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    GoogleSheetsProvider: class {
      async readTableAsObjects() {
        return {headers: sheet.headers, rows: sheet.rows.map((r, i) => ({...r, _rowNumber: String(i + 2)}))};
      }
    },
  };
});

import {
  parseBlacha, splitSp, personKey, findInRegistry, sortRegistry, toPublic, validateBlachaInput,
} from "../src/modules/blachy/blachy_registry";
import {ARCHIWUM_2025, ARCHIWUM_MAX_NR} from "../src/modules/blachy/blachy_archiwum_2025";
import {usersSyncFieldsFromSheetTask} from "../src/service/tasks/usersSyncFieldsFromSheet";
import {handleAdminBlachy} from "../src/api/adminBlachyHandler";
import {handleGetKlubInfo} from "../src/api/getKlubInfoHandler";

// Końce semestrów z SETUP — sync arkusza członków sprawdza z nimi daty „Składki".
const SEMESTER_SETUP = {_docId: "vars_members", vars: {semestr_1_stop: {value: "02-28"}, semestr_2_stop: {value: "09-30"}}};

function seedDb(data: Record<string, any[]>) {
  return new FakeFirestore({setup: [SEMESTER_SETUP], ...data});
}

function ctx(db: FakeFirestore) {
  const logger = {info: () => undefined, warn: () => undefined, error: () => undefined};
  return {firestore: db as any, now: new Date(), dryRun: false, workspace: {} as any, config: {} as any, logger};
}

function mkRes() {
  const out: any = {status: 0, body: null};
  const res: any = {
    setHeader: () => res,
    status(c: number) {
      out.status = c;
      return res;
    },
    json(b: any) {
      out.body = b;
      return res;
    },
  };
  return {res, out};
}

async function callHandler(fn: any, db: FakeFirestore, method: string, body: any, uid = "adm") {
  const {res, out} = mkRes();
  let pending: Promise<void> = Promise.resolve();
  await fn({method, headers: {}, body, query: {}} as any, res, {
    db: db as any, sendPreflight: () => false, requireAllowedHost: () => true, setCorsHeaders: () => undefined,
    corsHandler: (_q: any, _s: any, f: any) => {
      pending = f();
    },
    requireIdToken: async () => ({decoded: {uid, email: "zarzad@morzkulc.pl"}}),
    adminRoleKeys: ["rola_zarzad", "rola_kr"],
  });
  await pending;
  return out;
}

describe("parsowanie i porównywanie", () => {
  it("kolumna blacha: rok, TRUE = rok nieznany, puste/FALSE = brak", () => {
    expect(parseBlacha("1998")).toEqual({has: true, rok: 1998});
    expect(parseBlacha("TRUE")).toEqual({has: true, rok: null});
    expect(parseBlacha(true)).toEqual({has: true, rok: null});
    expect(parseBlacha(2016)).toEqual({has: true, rok: 2016});
    for (const v of ["", "FALSE", "nie", "0", null]) expect(parseBlacha(v).has).toBe(false);
  });

  it("ś.p. w imieniu → flaga sp", () => {
    expect(splitSp("ś.p.Agnieszka")).toEqual({imie: "Agnieszka", sp: true});
    expect(splitSp("ś.p. Paweł")).toEqual({imie: "Paweł", sp: true});
    expect(splitSp("Paweł")).toEqual({imie: "Paweł", sp: false});
  });

  it("dopasowanie: e-mail, ID członka albo imię+nazwisko (bez polskich znaków, nawiasów)", () => {
    expect(personKey("Łukasz", "Opałka")).toBe("lukasz|opalka");
    expect(personKey("Dorota", "Woźniak (Górska)")).toBe("dorota|wozniak");
    const reg = [
      {id: "bo_1", d: {imie: "Monika", nazwisko: "Milewczyk / Żelazkiewicz", email: "monika@x.pl", memberId: null}},
      {id: "m_7", d: {imie: "Ala", nazwisko: "Kot", email: "", memberId: 7}},
    ];
    expect(findInRegistry(reg, {email: "MONIKA@x.pl", memberId: 1, imie: "", nazwisko: ""})).toBe("bo_1");
    expect(findInRegistry(reg, {email: "", memberId: 7, imie: "", nazwisko: ""})).toBe("m_7");
    expect(findInRegistry(reg, {email: "inny@x.pl", memberId: 9, imie: "Monika", nazwisko: "Milewczyk"})).toBe("bo_1");
    expect(findInRegistry(reg, {email: "inny@x.pl", memberId: 9, imie: "Ola", nazwisko: "Nowak"})).toBeNull();
  });

  it("kolejność: archiwum wg pozycji, potem nowsze po roku, numerze, nazwisku; walidacja formularza", () => {
    const l = sortRegistry([
      toPublic("a", {nazwisko: "Zet", rok: 2027}),
      toPublic("b", {nazwisko: "Bet", rok: 2027}),
      toPublic("h", {nazwisko: "Hon", rok: 1997, honorowa: true, zrodlo: "archiwum_2025", poz: 8}),
      toPublic("x", {nazwisko: "Skarbek", zrodlo: "archiwum_2025", poz: 1}),
      toPublic("n", {nazwisko: "Nowy", rok: 2026, nr: 40}),
    ]);
    expect(l.map((x) => x.id)).toEqual(["x", "h", "n", "b", "a"]);
    expect(validateBlachaInput({imie: "Ala", nazwisko: "Kot", rok: "2027"}, 2026).ok).toBe(false);
    expect(validateBlachaInput({imie: "Ala", nazwisko: "Kot", rok: "2025"}, 2026).ok).toBe(false);
    expect(validateBlachaInput({ksywa: "Macias", rok: ""}, 2026).ok).toBe(false);
    expect(validateBlachaInput({ksywa: "Macias", rok: "2026", nr: "39"}, 2026).ok).toBe(false);
    expect(validateBlachaInput({ksywa: "Macias", rok: "2026", data: "2025-12-06"}, 2026).ok).toBe(false);
    const ok = validateBlachaInput({ksywa: "Macias", rok: "2026", nr: "40", data: "2026-12-05", miejsce: "Bartel Wielki", okazja: "LI urodziny"}, 2026);
    expect(ok).toMatchObject({ok: true, data: {nr: 40, data: "2026-12-05", miejsce: "Bartel Wielki", okazja: "LI urodziny"}});
    expect(validateBlachaInput({imie: "Ala"}, 2026).ok).toBe(false);
  });
});

describe("archiwum klubowe 2025", () => {
  it("45 wpisów: 2 nienumerowane, numery 00–39 bez luk i powtórzeń, 3 honorowe, daty do 2025", () => {
    expect(ARCHIWUM_2025).toHaveLength(45);
    const nrs = ARCHIWUM_2025.map((b) => b.nr).filter((n): n is number => n != null);
    expect(nrs).toEqual(Array.from({length: 40}, (_, i) => i));
    expect(ARCHIWUM_MAX_NR).toBe(39);
    expect(ARCHIWUM_2025.filter((b) => b.honorowa).map((b) => b.nazwisko)).toEqual(["Darkowski", "Sośnicki", "Powroźnik"]);
    expect(ARCHIWUM_2025.filter((b) => b.nr == null && !b.honorowa).map((b) => b.data)).toEqual([null, null]);
    expect(ARCHIWUM_2025.every((b) => !b.data || b.data <= "2025-12-31")).toBe(true);
    expect(new Set(ARCHIWUM_2025.map((b) => b.poz)).size).toBe(45);
  });
});

describe("sync arkusza członków", () => {
  const H = ["ID", "ksywa", "imię", "nazwisko", "telefon", "e-mail", "data urodzenia", "rok szkoleniówki", "Wpisowe (mm.yyyy)",
    "klucze do siedziby", "Rola", "Status", "blacha", "uwagi", "Zgody RODO", "składki", "godzinki"];
  const row = (o: Record<string, string>) => ({"Rola": "Członek", "Status": "Aktywny", ...o});

  beforeEach(() => {
    sheet.headers = H;
  });

  it("nowa blacha w arkuszu → wpis m_<ID>; znana osoba bez duplikatu; pusta komórka niczego nie kasuje", async () => {
    sheet.rows = [
      row({"ID": "21", "ksywa": "Bralczyk", "imię": "Marcin", "nazwisko": "Korbas", "e-mail": "fgk@x.pl", "blacha": "2022"}),
      row({"ID": "95", "imię": "Ola", "nazwisko": "Nowak", "e-mail": "ola@x.pl", "blacha": "2026"}),
      // Blachy do 2025 (i bez roku) są wyłącznie w archiwum — arkusz ich nie dopisuje.
      row({"ID": "96", "imię": "Jan", "nazwisko": "Spoza", "e-mail": "jan@x.pl", "blacha": "2024"}),
      row({"ID": "97", "imię": "Ewa", "nazwisko": "Bezroku", "e-mail": "ewa@x.pl", "blacha": "TRUE"}),
      row({"ID": "70", "imię": "Monika", "nazwisko": "Milewczyk", "e-mail": "monika@x.pl", "blacha": ""}),
    ];
    const db = seedDb({
      blachy: [
        {_docId: "bo_531", imie: "Marcin", nazwisko: "Korbas", email: "fgk@x.pl", rok: 2022, memberId: null},
        {_docId: "bo_348", imie: "Monika", nazwisko: "Milewczyk / Żelazkiewicz", email: "monika@x.pl", rok: 2018, memberId: null},
      ],
      users_active: [{_docId: "u70", memberId: 70, email: "monika@x.pl", role_key: "rola_czlonek", status_key: "status_aktywny",
        profile: {}, admin: {badge: "2018"}}],
    });
    const r = await usersSyncFieldsFromSheetTask.run({}, ctx(db));
    expect(r.ok).toBe(true);
    expect((r.details as any).blachyAdded).toEqual(["Ola Nowak"]);
    const docs = db.dump("blachy") as any[];
    expect(docs).toHaveLength(3);
    expect(docs.find((d) => d.memberId === 95)).toMatchObject({rok: 2026, zrodlo: "arkusz_czlonkow", email: "ola@x.pl"});
    expect(docs.find((d) => d.email === "monika@x.pl").rok).toBe(2018);
    // admin.badge nie jest już synchronizowane (stara wartość zostaje do sprzątnięcia skryptem)
    expect((db.dump("users_active") as any[])[0].admin.badge).toBe("2018");

    const again = await usersSyncFieldsFromSheetTask.run({}, ctx(db));
    expect((again.details as any).blachyAdded).toEqual([]);
  });

  it("składki/ID: zły format daty, członek bez ID w arkuszu, konto członka bez ID spoza arkusza → sync przerwany bez zapisów", async () => {
    sheet.rows = [
      row({"ID": "1", "imię": "Ala", "nazwisko": "Zła", "e-mail": "ala@x.pl", "składki": "wrzesień 2026"}),
      row({"ID": "", "imię": "Bez", "nazwisko": "Id", "e-mail": "bez@x.pl"}),
      row({"ID": "3", "imię": "Ok", "nazwisko": "Dobra", "e-mail": "ok@x.pl", "składki": "28.02.2027"}),
    ];
    const db = seedDb({users_active: [
      {_docId: "u1", memberId: 1, email: "ala@x.pl", role_key: "rola_czlonek", status_key: "status_aktywny", profile: {}, admin: {contributions: "2026-09-30"}},
      {_docId: "u9", email: "sierota@x.pl", displayName: "Sierota Konto", role_key: "rola_czlonek", status_key: "status_aktywny",
        profile: {firstName: "Sierota", lastName: "Konto", phone: "1", dateOfBirth: "2000-01-01", consentRodo: true, consentStatute: true}},
      // niedokończona rejestracja — nie blokuje (obsługuje users.incompleteRegistration)
      {_docId: "u8", email: "niedokonczone@x.pl", role_key: "rola_czlonek", status_key: "status_aktywny", profile: {}},
    ]});
    const r = await usersSyncFieldsFromSheetTask.run({}, ctx(db));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Synchronizacja przerwana/);
    expect(r.message).toMatch(/#1 .*wrzesień 2026/);
    expect(r.message).toMatch(/Bez Id .*brak ID/);
    expect(r.message).toMatch(/sierota@x\.pl.*bez ID/);
    expect(r.message).not.toMatch(/Dobra/);
    expect(r.message).not.toMatch(/niedokonczone/);
    expect((db.dump("users_active") as any[]).find((u) => u.memberId === 1).admin.contributions).toBe("2026-09-30");
  });

  it("konto członka bez ID z e-mailem w arkuszu → połączone z wierszem, składki z arkusza", async () => {
    sheet.rows = [row({"ID": "40", "imię": "Karo", "nazwisko": "Bezid", "e-mail": "karo@x.pl", "składki": "2027-02-28"})];
    const db = seedDb({users_active: [
      {_docId: "u40", email: "karo@x.pl", role_key: "rola_czlonek", status_key: "status_aktywny", profile: {}, admin: {contributions: "2026-09-30"}},
    ]});
    const r = await usersSyncFieldsFromSheetTask.run({}, ctx(db));
    expect(r.ok).toBe(true);
    expect((r.details as any).linkedByEmail).toBe(1);
    const u = (db.dump("users_active") as any[])[0];
    expect(u.memberId).toBe(40);
    expect(u.admin.contributions).toBe("2027-02-28");
  });

  it("składki: data spoza końców semestrów z SETUP albo nieistniejąca → sync przerwany ze wskazaniem osoby", async () => {
    sheet.rows = [
      row({"ID": "91", "imię": "Bartek", "nazwisko": "Luty", "e-mail": "b@x.pl", "składki": "2027-02-29"}),
      row({"ID": "119", "imię": "Waldek", "nazwisko": "Dwudziesty", "e-mail": "w@x.pl", "składki": "20.02.2027"}),
      row({"ID": "5", "imię": "Ewa", "nazwisko": "Marzec", "e-mail": "e@x.pl", "składki": "2026-03-31"}),
      row({"ID": "6", "imię": "Ok", "nazwisko": "Wrzesien", "e-mail": "o@x.pl", "składki": "30.09.2026"}),
    ];
    const db = seedDb({users_active: [
      {_docId: "u5", memberId: 5, email: "e@x.pl", role_key: "rola_czlonek", status_key: "status_aktywny", profile: {}, admin: {contributions: "2026-02-28"}},
    ]});
    const r = await usersSyncFieldsFromSheetTask.run({}, ctx(db));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/#91 Bartek Luty: .*2027-02-29.*istniejącą datę/);
    expect(r.message).toMatch(/#119 Waldek Dwudziesty: .*20\.02\.2027.*koniec semestru z SETUP \(02-28 \/ 09-30\)/);
    expect(r.message).toMatch(/#5 Ewa Marzec: .*2026-03-31/);
    expect(r.message).not.toMatch(/Wrzesien/);
    expect((db.dump("users_active") as any[])[0].admin.contributions).toBe("2026-02-28");
  });

  it("składki: cofnięcie albo usunięcie daty → stop bez zapisów; potwierdzenie dokładnie tych zmian → zapis", async () => {
    sheet.rows = [
      row({"ID": "1", "imię": "Ala", "nazwisko": "Cofnieta", "e-mail": "a@x.pl", "składki": "2026-02-28"}),
      row({"ID": "2", "imię": "Ola", "nazwisko": "Pusta", "e-mail": "o@x.pl", "składki": ""}),
      row({"ID": "3", "imię": "Ewa", "nazwisko": "Dalej", "e-mail": "e@x.pl", "składki": "2027-02-28"}),
    ];
    const acc = (id: number, c: string) => ({_docId: `u${id}`, memberId: id, email: ["a", "o", "e"][id - 1] + "@x.pl",
      role_key: "rola_czlonek", status_key: "status_aktywny", profile: {}, admin: {contributions: c}});
    const db = seedDb({users_active: [acc(1, "2026-09-30"), acc(2, "2026-09-30"), acc(3, "2026-09-30")]});
    const r = await usersSyncFieldsFromSheetTask.run({}, ctx(db));
    expect(r.ok).toBe(false);
    expect((r.details as any).needsConfirmation).toBe(true);
    expect(r.message).toMatch(/#1 Ala Cofnieta: 2026-09-30 → 2026-02-28/);
    expect(r.message).toMatch(/#2 Ola Pusta: 2026-09-30 → \(puste\)/);
    expect(r.message).not.toMatch(/Dalej/);
    const contrib = () => (db.dump("users_active") as any[]).map((u) => u.admin.contributions);
    expect(contrib()).toEqual(["2026-09-30", "2026-09-30", "2026-09-30"]);

    // Potwierdzenie tylko części zmian → nadal stop.
    const tokens: string[] = (r.details as any).confirmDuesRollback;
    expect((await usersSyncFieldsFromSheetTask.run({confirmDuesRollback: [tokens[0]]}, ctx(db))).ok).toBe(false);

    const ok = await usersSyncFieldsFromSheetTask.run({confirmDuesRollback: tokens}, ctx(db));
    expect(ok.ok).toBe(true);
    expect(contrib()).toEqual(["2026-02-28", "", "2027-02-28"]);
  });

  it("wpisowe: MM.RRRR → miesiąc wpłaty w bazie, stare pole entryFeeYear usuwane; inny format → sync przerwany", async () => {
    sheet.rows = [row({"ID": "7", "imię": "Kan", "nazwisko": "Dydat", "e-mail": "k@x.pl", "Rola": "Kandydat", "Wpisowe (mm.yyyy)": "08.2026", "składki": "2027-02-28"})];
    const db = seedDb({users_active: [{_docId: "u7", memberId: 7, email: "k@x.pl", role_key: "rola_kandydat", status_key: "status_aktywny",
      profile: {}, admin: {contributions: "2027-02-28", entryFeeYear: "2026", entryFeePaidAt: "2026-11"}}]});
    expect((await usersSyncFieldsFromSheetTask.run({}, ctx(db))).ok).toBe(true);
    const u = (db.dump("users_active") as any[])[0];
    expect(u.admin).toMatchObject({entryFee: "08.2026", entryFeePaidAt: "2026-08"});
    expect(u.admin.entryFeeYear).toBeUndefined();

    sheet.rows = [row({"ID": "7", "imię": "Kan", "nazwisko": "Dydat", "e-mail": "k@x.pl", "Rola": "Kandydat", "Wpisowe (mm.yyyy)": "2026", "składki": "2027-02-28"})];
    const r = await usersSyncFieldsFromSheetTask.run({}, ctx(db));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/#7 Kan Dydat: „Wpisowe" = „2026" — wpisz miesiąc wpłaty jako MM\.RRRR/);
  });

  it("składki: brak końców semestrów w SETUP → sync przerwany", async () => {
    sheet.rows = [row({"ID": "6", "imię": "Ok", "nazwisko": "Wrzesien", "e-mail": "o@x.pl", "składki": "2026-09-30"})];
    const db = new FakeFirestore({users_active: []});
    const r = await usersSyncFieldsFromSheetTask.run({}, ctx(db));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/semestr_1_stop/);
  });
});

describe("endpointy", () => {
  const admins = [{_docId: "adm", email: "zarzad@morzkulc.pl", role_key: "rola_zarzad"}, {_docId: "usr", role_key: "rola_czlonek"}];

  it("zarząd: dodaje osobę spoza klubu, poprawia, usuwa; członek → 403; błędny rok → 400", async () => {
    const db = seedDb({users_active: admins});
    const add = await callHandler(handleAdminBlachy, db, "POST",
      {action: "add", data: {imie: "Jan", nazwisko: "Obcy", klub: "KK Wiking", rok: "2026", uzasadnienie: "Wspólne wyprawy"}});
    expect(add.status).toBe(200);
    const id = add.body.blacha.id;
    expect((db.dump("blachy") as any[])[0]).toMatchObject({zrodlo: "aplikacja", klub: "KK Wiking", rok: 2026, honorowa: false});

    expect((await callHandler(handleAdminBlachy, db, "POST", {action: "update", id, data: {imie: "Jan", nazwisko: "Obcy", rok: "2026", nr: "42"}})).status).toBe(200);
    expect((db.dump("blachy") as any[])[0].nr).toBe(42);
    expect((await callHandler(handleAdminBlachy, db, "POST", {action: "add", data: {imie: "A", nazwisko: "B", rok: "1800"}})).status).toBe(400);
    expect((await callHandler(handleAdminBlachy, db, "POST", {action: "delete", id}, "usr")).status).toBe(403);
    expect((await callHandler(handleAdminBlachy, db, "POST", {action: "delete", id})).status).toBe(200);
    expect(db.dump("blachy")).toHaveLength(0);
  });

  it("wpis z archiwum klubowego: bez poprawek i usuwania (409)", async () => {
    const db = seedDb({users_active: admins,
      blachy: [{_docId: "archiwum_03", imie: "Artur", nazwisko: "Roman", ksywa: "Melon", rok: 1996, nr: 0, zrodlo: "archiwum_2025", poz: 3}]});
    const upd = await callHandler(handleAdminBlachy, db, "POST", {action: "update", id: "archiwum_03", data: {imie: "Artur", nazwisko: "X", rok: "2026"}});
    expect(upd.status).toBe(409);
    expect((await callHandler(handleAdminBlachy, db, "POST", {action: "delete", id: "archiwum_03"})).status).toBe(409);
    expect((db.dump("blachy") as any[])[0].nazwisko).toBe("Roman");
  });

  it("/api/klub: rejestr dla każdego zalogowanego, bez e-maili; edycja tylko dla zarządu/KR", async () => {
    const db = seedDb({
      users_active: admins,
      blachy: [{_docId: "archiwum_03", imie: "Artur", nazwisko: "Roman", ksywa: "Melon", rok: 1996, nr: 0, honorowa: false,
        data: "1996-12-14", miejsce: "Borkowo", okazja: "XXI urodziny", email: "m@x.pl", sp: false, zrodlo: "archiwum_2025", poz: 3}],
    });
    const user = await callHandler(handleGetKlubInfo, db, "GET", null, "usr");
    expect(user.status).toBe(200);
    expect(user.body.blachy).toEqual([{id: "archiwum_03", imie: "Artur", nazwisko: "Roman", ksywa: "Melon", rok: 1996, nr: 0,
      honorowa: false, data: "1996-12-14", miejsce: "Borkowo", okazja: "XXI urodziny",
      uzasadnienie: "", klub: "", zalozycielska: "", sp: false, archiwum: true, poz: 3}]);
    expect(user.body.blachyArchiwum.doRoku).toBe(2025);
    expect(JSON.stringify(user.body)).not.toContain("m@x.pl");
    expect(user.body.canEditBlachy).toBe(false);
    expect((await callHandler(handleGetKlubInfo, db, "GET", null, "adm")).body.canEditBlachy).toBe(true);
  });
});
