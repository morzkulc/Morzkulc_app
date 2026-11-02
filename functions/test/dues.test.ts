/**
 * Składki i wpisowe w aplikacji (dues_service.ts, duesTasks.ts, /api/dues, /api/admin/dues) — kod
 * PRODUKCYJNY na fake Firestore + mock arkusza członków.
 */
import {describe, it, expect, vi, beforeEach} from "vitest";
import {FakeFirestore, ts} from "./helpers/fake_firestore";

const sheet = {headers: [] as string[], rows: [] as Array<Record<string, string>>, writes: [] as Array<{row: number; patch: Record<string, string>; mode?: string}>};
vi.mock("../src/service/providers/googleSheetsProvider", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    GoogleSheetsProvider: class {
      async readTableAsObjects() {
        return {headers: sheet.headers, rows: sheet.rows.map((r, i) => ({...r, _rowNumber: String(i + 2)}))};
      }
      async writeRowCells(_cfg: any, row: number, patch: Record<string, string>, mode = "RAW") {
        sheet.writes.push({row, patch, mode});
        Object.assign(sheet.rows[row - 2], patch);
      }
    },
  };
});

import {
  approveDuesOrder, computeDuesStatus, createDuesOrder, overdueSemesters, paidUntilAfterPayment, rejectDuesOrder,
  cancelOwnDuesOrder, transferTitle,
} from "../src/modules/dues/dues_service";
import {getAppVars} from "../src/modules/setup/app_vars";
import {duesDailyTask, duesNotifyOrderTask, duesWriteBackTask} from "../src/service/tasks/duesTasks";
import {handleAdminDues} from "../src/api/adminDuesHandler";
import {isDuesPaid, isSemesterEndDate} from "../src/modules/users/member_standing";

const ENDS = ["02-28", "09-30"];
const VARS = {_docId: "vars_members", vars: {
  "semestr_1_stop": {value: "02-28"}, "semestr_2_stop": {value: "09-30"}, "składka": {value: 75},
  "skarbnik": {value: "skarb@x.pl"}, "konto_klubowe": {value: "12 3456"},
}};

function user(id: string, roleKey: string, contributions = "", memberId: number | null = 10) {
  return {_docId: id, role_key: roleKey, status_key: "status_aktywny", email: `${id.toLowerCase()}@x.pl`, memberId,
    profile: {firstName: id, lastName: "Test"}, admin: {contributions}};
}

function seed(users: any[], extra: Record<string, any[]> = {}) {
  const fake = new FakeFirestore({setup: [VARS], users_active: users, ...extra});
  return {fake, db: fake.asDb()};
}

async function data(db: any, uid: string) {
  return (await db.collection("users_active").doc(uid).get()).data();
}

function ctx(db: any, sent: any[] = []) {
  const logger = {info: () => undefined, warn: () => undefined, error: () => undefined};
  const workspace = {sendGenericEmail: async (to: string, subject: string, body: string) => {
    sent.push({to, subject, body});
  }};
  return {firestore: db, now: new Date(), dryRun: false, workspace: workspace as any, config: {} as any, logger};
}

describe("daty semestrów", () => {
  it("zaległość: liczba końców semestrów od „opłacone do” do końca bieżącego semestru", () => {
    expect(overdueSemesters("", "2026-11-02", ENDS)).toBeNull();
    expect(overdueSemesters("2027-02-28", "2026-11-02", ENDS)).toBe(0);
    expect(overdueSemesters("2026-09-30", "2026-11-02", ENDS)).toBe(1);
    expect(overdueSemesters("2025-09-30", "2026-11-02", ENDS)).toBe(3);
    expect(overdueSemesters("2022-09-30", "2026-11-02", ENDS)).toBe(9);
    expect(overdueSemesters("2018-03-31", "2026-11-02", ENDS)).toBe(18);
  });

  it("nowa data: pierwsza wpłata → koniec bieżącego semestru; kontynuacja → najpierw zaległość", () => {
    expect(paidUntilAfterPayment("", 1, "2026-11-02", ENDS)).toBe("2027-02-28");
    expect(paidUntilAfterPayment("", 2, "2026-11-02", ENDS)).toBe("2027-09-30");
    expect(paidUntilAfterPayment("2025-09-30", 2, "2026-11-02", ENDS)).toBe("2026-09-30");
    expect(paidUntilAfterPayment("2027-02-28", 1, "2026-11-02", ENDS)).toBe("2027-09-30");
  });

  it("rok przestępny: koniec lutego = 29.02; 28.02.2028 z arkusza traktowane jak 29.02", () => {
    expect(paidUntilAfterPayment("2027-09-30", 1, "2026-11-02", ENDS)).toBe("2028-02-29");
    expect(paidUntilAfterPayment("2028-02-28", 1, "2026-11-02", ENDS)).toBe("2028-09-30");
    expect(isDuesPaid({admin: {contributions: "2028-02-28"}}, "2028-02-29")).toBe(true);
    expect(isSemesterEndDate("2028-02-29", ENDS)).toBe(true);
    expect(isSemesterEndDate("2028-02-28", ENDS)).toBe(true);
  });

  it("tytuł przelewu: „Składka Imię Nazwisko (ID: n); kod zgłoszenia”", () => {
    expect(transferTitle("skladka", "Krzysztof Świtek", 18, "2gxjnw123")).toBe("Składka Krzysztof Świtek (ID: 18); 2GXJNW");
    expect(transferTitle("wpisowe", "Ala  Kot×", 7, "xyz999")).toBe("Wpisowe Ala Kot (ID: 7); XYZ999");
  });
});

describe("status i zgłoszenie", () => {
  it("członek: kwota 75 × n; kandydat: wpisowe zawsze 2 semestry; sympatyk/bez ID/zaległość > 8 — bez zgłoszenia", async () => {
    const {db} = seed([]);
    const vars = await getAppVars(db);
    expect(computeDuesStatus(user("A", "rola_czlonek", "2026-09-30"), vars, "2026-11-02")).toMatchObject({canOrder: true, kind: "skladka", overdue: 1, feePln: 75});
    expect(computeDuesStatus(user("K", "rola_kandydat"), vars, "2026-11-02")).toMatchObject({canOrder: true, kind: "wpisowe", fixedSemesters: 2, overdue: null});
    expect(computeDuesStatus(user("S", "rola_sympatyk"), vars).applicable).toBe(false);
    expect(computeDuesStatus(user("N", "rola_czlonek", "", null), vars).reason).toMatch(/numeru członkowskiego/);
    const blocked = computeDuesStatus(user("B", "rola_czlonek", "2022-09-30"), vars, "2026-11-02");
    expect(blocked).toMatchObject({canOrder: false, blocked: true, overdue: 9});
    expect(blocked.reason).toMatch(/kontakt|skontaktuj/);
  });

  it("zgłoszenie: pending + mail z danymi przelewu; drugie zgłoszenie odrzucone; anulowanie własnego", async () => {
    const {fake, db} = seed([user("A", "rola_czlonek", "2026-09-30")]);
    const o = await createDuesOrder(db, {uid: "A", userData: await data(db, "A"), userName: "A Test", semesters: 3});
    expect(o).toMatchObject({status: "pending", semesters: 3, amountPln: 225, kind: "skladka"});
    await expect(createDuesOrder(db, {uid: "A", userData: await data(db, "A"), userName: "A Test", semesters: 1})).rejects.toThrow(/już zgłoszoną/);
    expect(fake.dump("service_jobs")).toEqual([expect.objectContaining({taskId: "dues.notifyOrder", payload: {orderId: o.id, kind: "created"}})]);
    const sent: any[] = [];
    await duesNotifyOrderTask.run({orderId: o.id, kind: "created"}, ctx(db, sent));
    expect(sent[0].body).toMatch(/225 zł/);
    expect(sent[0].body).toMatch(/12 3456/);
    expect(sent[0].body).toContain(o.transferTitle);
    await cancelOwnDuesOrder(db, {uid: "A", orderId: o.id});
    expect((fake.dump("dues_orders") as any[])[0].status).toBe("cancelled");
  });

  it("kandydat: wpisowe 150 zł niezależnie od podanej liczby semestrów", async () => {
    const {db} = seed([user("K", "rola_kandydat")]);
    const o = await createDuesOrder(db, {uid: "K", userData: await data(db, "K"), userName: "K Test", semesters: 7});
    expect(o).toMatchObject({kind: "wpisowe", semesters: 2, amountPln: 150});
  });
});

describe("potwierdzenie → arkusz → baza", () => {
  beforeEach(() => {
    sheet.headers = ["ID", "imię", "składki", "Wpisowe (mm.yyyy)"];
    sheet.writes = [];
  });

  it("skarbnik potwierdza: data do arkusza, potem do bazy, mail z nową datą; ponowne uruchomienie nic nie dubluje", async () => {
    sheet.rows = [{"ID": "10", "imię": "A", "składki": "2025-09-30", "Wpisowe (mm.yyyy)": ""}];
    const {fake, db} = seed([user("A", "rola_czlonek", "2025-09-30")]);
    const o = await createDuesOrder(db, {uid: "A", userData: await data(db, "A"), userName: "A Test", semesters: 2});
    expect(await approveDuesOrder(db, {orderId: o.id, performedBy: "SKARB", todayIso: "2026-11-02"})).toEqual({from: "2025-09-30", to: "2026-09-30"});
    // Przed zapisem do arkusza baza bez zmian.
    expect((await data(db, "A")).admin.contributions).toBe("2025-09-30");

    const r = await duesWriteBackTask.run({orderId: o.id}, ctx(db));
    expect(r.ok).toBe(true);
    expect(sheet.writes).toEqual([{row: 2, patch: {"składki": "2026-09-30"}, mode: "USER_ENTERED"}]);
    expect((await data(db, "A")).admin.contributions).toBe("2026-09-30");
    expect((fake.dump("dues_orders") as any[])[0].writeBack.status).toBe("done");
    expect((fake.dump("service_jobs") as any[]).map((j) => j.payload.kind || j.taskId)).toContain("booked");

    await duesWriteBackTask.run({orderId: o.id}, ctx(db));
    expect(sheet.writes).toHaveLength(1);
  });

  it("wpisowe kandydata: Składki (data) + „Wpisowe (mm.yyyy)” (MM.RRRR) w arkuszu i w bazie", async () => {
    sheet.rows = [{"ID": "10", "imię": "K", "składki": "", "Wpisowe (mm.yyyy)": ""}];
    const {db} = seed([user("K", "rola_kandydat")]);
    const o = await createDuesOrder(db, {uid: "K", userData: await data(db, "K"), userName: "K Test", semesters: 2});
    const {to} = await approveDuesOrder(db, {orderId: o.id, performedBy: "SKARB"});
    await duesWriteBackTask.run({orderId: o.id}, ctx(db));
    expect(sheet.writes).toEqual([
      {row: 2, patch: {"składki": to}, mode: "USER_ENTERED"},
      {row: 2, patch: {"Wpisowe (mm.yyyy)": expect.stringMatching(/^\d{2}\.\d{4}$/)}, mode: "RAW"},
    ]);
    const u = await data(db, "K");
    expect(u.admin.contributions).toBe(to);
    expect(u.admin.entryFee).toMatch(/^\d{2}\.\d{4}$/);
    expect(u.admin.entryFeePaidAt).toMatch(/^\d{4}-\d{2}$/);
  });

  it("ktoś zmienił datę w arkuszu po potwierdzeniu → konflikt, bez nadpisania i bez zmiany w bazie", async () => {
    sheet.rows = [{"ID": "10", "imię": "A", "składki": "2026-09-30", "Wpisowe (mm.yyyy)": ""}];
    const {fake, db} = seed([user("A", "rola_czlonek", "2025-09-30")]);
    const o = await createDuesOrder(db, {uid: "A", userData: await data(db, "A"), userName: "A Test", semesters: 1});
    await approveDuesOrder(db, {orderId: o.id, performedBy: "SKARB"});
    await duesWriteBackTask.run({orderId: o.id}, ctx(db));
    expect(sheet.writes).toEqual([]);
    expect((await data(db, "A")).admin.contributions).toBe("2025-09-30");
    expect((fake.dump("dues_orders") as any[])[0].writeBack).toMatchObject({status: "conflict", message: expect.stringMatching(/ID 10/)});
  });

  it("odrzucenie wymaga powodu i wysyła mail", async () => {
    const {fake, db} = seed([user("A", "rola_czlonek", "2026-09-30")]);
    const o = await createDuesOrder(db, {uid: "A", userData: await data(db, "A"), userName: "A Test", semesters: 1});
    await expect(rejectDuesOrder(db, {orderId: o.id, performedBy: "SKARB", reason: " "})).rejects.toThrow(/powód/);
    await rejectDuesOrder(db, {orderId: o.id, performedBy: "SKARB", reason: "brak przelewu"});
    expect((fake.dump("service_jobs") as any[]).map((j) => j.payload.kind)).toEqual(["created", "rejected"]);
    await expect(approveDuesOrder(db, {orderId: o.id, performedBy: "SKARB"})).rejects.toThrow(/rozpatrzone/);
  });
});

function mkRes() {
  const out: any = {status: 0, body: null};
  const res: any = {setHeader: () => res, status(c: number) {
    out.status = c; return res;
  }, json(b: any) {
    out.body = b; return res;
  }};
  return {res, out};
}

async function callAdmin(db: any, uid: string, email: string, method: string, body: any = {}) {
  const {res, out} = mkRes();
  let pending: Promise<void> = Promise.resolve();
  await handleAdminDues({method, headers: {}, body, query: {}} as any, res, {
    db, sendPreflight: () => false, requireAllowedHost: () => true, setCorsHeaders: () => undefined,
    corsHandler: (_q: any, _s: any, f: any) => {
      pending = f();
    },
    requireIdToken: async () => ({decoded: {uid, email}}), adminRoleKeys: ["rola_zarzad", "rola_kr"],
  });
  await pending;
  return out;
}

describe("panel Zarządu → Składki", () => {
  it("Zarząd widzi, tylko skarbnik obsługuje; zaległości > 8 semestrów na osobnej liście", async () => {
    const {fake, db} = seed([
      {...user("ZARZ", "rola_zarzad", "2099-09-30"), email: "zarz@x.pl"},
      {...user("SKARB", "rola_czlonek", "2099-09-30"), email: "skarb@x.pl"},
      user("ZAL", "rola_czlonek", "2025-09-30"),
      user("ZAL1", "rola_czlonek", "2026-09-30"),
      user("STARY", "rola_czlonek", "2015-09-30"),
      user("NOWY", "rola_kandydat"),
      user("SYMP", "rola_sympatyk"),
    ]);
    const view = await callAdmin(db, "ZARZ", "zarz@x.pl", "GET");
    expect(view.status).toBe(200);
    expect(view.body.isTreasurer).toBe(false);
    expect(view.body.overdue.map((r: any) => [r.uid, r.overdue])).toEqual([["NOWY", null], ["ZAL1", 1], ["ZAL", 3]]); // „brak wpłat” na górze, potem rosnąco
    expect(view.body.overdueBlocked.map((r: any) => r.uid)).toEqual(["STARY"]);
    expect((await callAdmin(db, "ZARZ", "zarz@x.pl", "POST", {action: "remind", uids: ["ZAL"]})).status).toBe(403);
    expect((await callAdmin(db, "SYMP", "symp@x.pl", "GET")).status).toBe(403);

    const r = await callAdmin(db, "SKARB", "skarb@x.pl", "POST", {action: "remind", uids: ["ZAL", "STARY"]});
    expect(r.body).toMatchObject({ok: true, queued: 2});
    expect((fake.dump("service_jobs") as any[]).map((j) => j.payload.uid)).toEqual(["ZAL", "STARY"]);
  });
});

describe("dues.daily", () => {
  it("alert do skarbnika o zgłoszeniu > 3 dni (raz); przypomnienie tylko dla chętnych, raz na datę", async () => {
    const {fake, db} = seed([
      {...user("CHCE", "rola_czlonek", "2026-09-30"), profile: {firstName: "Chce", lastName: "T", notifications: {duesReminder: true}}},
      user("NIE", "rola_czlonek", "2026-09-30"),
    ], {dues_orders: [
      {_docId: "o1", id: "o1", uid: "NIE", memberId: 10, userName: "Nie T", kind: "skladka", semesters: 1, amountPln: 75,
        transferTitle: "Skladka 1 sem", status: "pending", createdAt: ts("2026-01-01T00:00:00Z")},
      {_docId: "o2", id: "o2", uid: "X", memberId: 11, userName: "Swiezy", kind: "skladka", semesters: 1, amountPln: 75,
        transferTitle: "t", status: "pending", createdAt: ts(new Date().toISOString())},
    ]});
    const sent: any[] = [];
    const r = await duesDailyTask.run({}, ctx(db, sent));
    expect(r.details).toMatchObject({alerted: 1, reminded: 1});
    expect(sent.find((m) => m.to === "skarbnik@morzkulc.pl").body).toMatch(/Nie T/);
    expect(sent.find((m) => m.to === "chce@x.pl")).toBeTruthy();
    expect(sent.find((m) => m.to === "nie@x.pl")).toBeFalsy();
    expect((fake.dump("dues_orders") as any[]).find((o) => o.id === "o2").treasurerAlertedAt).toBeUndefined();

    const again = await duesDailyTask.run({}, ctx(db, []));
    expect(again.details).toMatchObject({alerted: 0, reminded: 0});
  });
});
