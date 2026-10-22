/**
 * Rejestr Blach: parsowanie kolumny „blacha", import z bilansu otwarcia, sync arkusza członków
 * (tylko dopisuje, nigdy nie kasuje), endpoint zarządu i lista w /api/klub (bez e-maili).
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
import {blachyImportOpeningBalanceTask} from "../src/service/tasks/blachyImportOpeningBalance";
import {usersSyncFieldsFromSheetTask} from "../src/service/tasks/usersSyncFieldsFromSheet";
import {handleAdminBlachy} from "../src/api/adminBlachyHandler";
import {handleGetKlubInfo} from "../src/api/getKlubInfoHandler";

function seedDb(data: Record<string, any[]>) {
  return new FakeFirestore(data);
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

  it("kolejność: rok nieznany na początku, potem rok, numer, nazwisko; walidacja formularza", () => {
    const l = sortRegistry([
      toPublic("a", {nazwisko: "Zet", rok: 2000}),
      toPublic("b", {nazwisko: "Bet", rok: 2000}),
      toPublic("c", {nazwisko: "Cet"}),
      toPublic("d", {nazwisko: "Det", rok: 1996}),
    ]);
    expect(l.map((x) => x.id)).toEqual(["c", "d", "b", "a"]);
    expect(validateBlachaInput({imie: "Ala", nazwisko: "Kot", rok: "2027"}, 2026).ok).toBe(false);
    expect(validateBlachaInput({ksywa: "Macias", rok: ""}, 2026).ok).toBe(true);
    expect(validateBlachaInput({imie: "Ala"}, 2026).ok).toBe(false);
  });
});

describe("import z bilansu otwarcia", () => {
  beforeEach(() => {
    sheet.headers = ["ID", "Imię", "Nazwisko", "Ksywa", "e-mail", "blacha"];
    sheet.rows = [
      {"ID": "21", "Imię": "Maciej", "Nazwisko": "Skarbek", "Ksywa": "Macias", "e-mail": "M@x.pl", "blacha": "TRUE"},
      {"ID": "110", "Imię": "ś.p.Agnieszka", "Nazwisko": "Kozak (Gałka)", "Ksywa": "Gałka", "e-mail": "", "blacha": "2006"},
      {"ID": "26", "Imię": "Jarosław", "Nazwisko": "Wrzesień", "Ksywa": "", "e-mail": "", "blacha": ""},
    ];
  });

  it("dry nic nie zapisuje; import tworzy bo_<ID>, ponowny nie nadpisuje poprawek", async () => {
    const db = seedDb({});
    const p = {spreadsheetId: "S", tabName: "bilans otwarcia 26"};
    const dry = await blachyImportOpeningBalanceTask.run({...p, dry: true}, ctx(db));
    expect((dry.details as any).items).toHaveLength(2);
    expect(db.dump("blachy")).toHaveLength(0);

    await blachyImportOpeningBalanceTask.run(p, ctx(db));
    const docs = db.dump("blachy") as any[];
    expect(docs).toHaveLength(2);
    const ag = docs.find((d) => d.boId === "110");
    expect([ag.imie, ag.sp, ag.rok, ag.zrodlo]).toEqual(["Agnieszka", true, 2006, "bilans_otwarcia"]);
    expect(docs.find((d) => d.boId === "21")).toMatchObject({rok: null, email: "m@x.pl"});

    await (db as any).collection("blachy").doc("bo_21").update({nr: 1});
    await blachyImportOpeningBalanceTask.run(p, ctx(db));
    expect((db.dump("blachy") as any[]).find((d) => d.boId === "21").nr).toBe(1);
  });
});

describe("sync arkusza członków", () => {
  const H = ["ID", "ksywa", "imię", "nazwisko", "telefon", "e-mail", "data urodzenia", "rok szkoleniówki", "wpisowe rok",
    "klucze do siedziby", "Rola", "Status", "blacha", "uwagi", "Zgody RODO", "składki", "godzinki"];
  const row = (o: Record<string, string>) => ({"Rola": "Członek", "Status": "Aktywny", ...o});

  beforeEach(() => {
    sheet.headers = H;
  });

  it("nowa blacha w arkuszu → wpis m_<ID>; znana osoba bez duplikatu; pusta komórka niczego nie kasuje", async () => {
    sheet.rows = [
      row({"ID": "21", "ksywa": "Bralczyk", "imię": "Marcin", "nazwisko": "Korbas", "e-mail": "fgk@x.pl", "blacha": "2022"}),
      row({"ID": "95", "imię": "Ola", "nazwisko": "Nowak", "e-mail": "ola@x.pl", "blacha": "2026"}),
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
});

describe("endpointy", () => {
  const admins = [{_docId: "adm", email: "zarzad@morzkulc.pl", role_key: "rola_zarzad"}, {_docId: "usr", role_key: "rola_czlonek"}];

  it("zarząd: dodaje osobę spoza klubu, poprawia, usuwa; członek → 403; błędny rok → 400", async () => {
    const db = seedDb({users_active: admins});
    const add = await callHandler(handleAdminBlachy, db, "POST",
      {action: "add", data: {imie: "Jan", nazwisko: "Obcy", klub: "KK Wiking", rok: "2025", uzasadnienie: "Wspólne wyprawy"}});
    expect(add.status).toBe(200);
    const id = add.body.blacha.id;
    expect((db.dump("blachy") as any[])[0]).toMatchObject({zrodlo: "aplikacja", klub: "KK Wiking", rok: 2025});

    expect((await callHandler(handleAdminBlachy, db, "POST", {action: "update", id, data: {imie: "Jan", nazwisko: "Obcy", nr: "42"}})).status).toBe(200);
    expect((db.dump("blachy") as any[])[0].nr).toBe(42);
    expect((await callHandler(handleAdminBlachy, db, "POST", {action: "add", data: {imie: "A", nazwisko: "B", rok: "1800"}})).status).toBe(400);
    expect((await callHandler(handleAdminBlachy, db, "POST", {action: "delete", id}, "usr")).status).toBe(403);
    expect((await callHandler(handleAdminBlachy, db, "POST", {action: "delete", id})).status).toBe(200);
    expect(db.dump("blachy")).toHaveLength(0);
  });

  it("/api/klub: rejestr dla każdego zalogowanego, bez e-maili; edycja tylko dla zarządu/KR", async () => {
    const db = seedDb({
      users_active: admins,
      blachy: [{_docId: "bo_21", imie: "Maciej", nazwisko: "Skarbek", ksywa: "Macias", rok: null, email: "m@x.pl", sp: false}],
    });
    const user = await callHandler(handleGetKlubInfo, db, "GET", null, "usr");
    expect(user.status).toBe(200);
    expect(user.body.blachy).toEqual([{id: "bo_21", imie: "Maciej", nazwisko: "Skarbek", ksywa: "Macias", rok: null, nr: null,
      uzasadnienie: "", klub: "", zalozycielska: "", sp: false}]);
    expect(JSON.stringify(user.body)).not.toContain("m@x.pl");
    expect(user.body.canEditBlachy).toBe(false);
    expect((await callHandler(handleGetKlubInfo, db, "GET", null, "adm")).body.canEditBlachy).toBe(true);
  });
});
