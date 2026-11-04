/**
 * Edycja własnych danych (profileDataHandler.ts + members.updateProfileInSheet) — kod produkcyjny
 * na fake Firestore + mock arkusza członków.
 */
import {describe, it, expect, vi, beforeEach} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";

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

import {handleProfileData} from "../src/api/profileDataHandler";
import {membersUpdateProfileInSheetTask} from "../src/service/tasks/membersUpdateProfileInSheet";
import {usersNotifyMinorMemberTask} from "../src/service/tasks/usersNotifyMinorMember";
import {ageOn, checkBirthDate} from "../src/modules/users/birth_date";

function seed(extraUsers: any[] = []) {
  const fake = new FakeFirestore({
    setup: [{_docId: "vars_members", vars: {konta_testowe: {value: "tester@x.pl"}}}],
    users_active: [
      {_docId: "A", email: "a@x.pl", memberId: 12, role_key: "rola_czlonek", status_key: "status_aktywny",
        profile: {firstName: "Jan", lastName: "Kowalski", phone: "600 100 200", dateOfBirth: "1990-05-01"}},
      ...extraUsers,
    ],
  });
  return {fake, db: fake.asDb()};
}

async function call(db: any, uid: string, method: string, body: any = {}) {
  const out: any = {};
  const res: any = {setHeader: () => res, status(c: number) {
    out.status = c; return res;
  }, json(b: any) {
    out.body = b; return res;
  }};
  let pending: Promise<void> = Promise.resolve();
  await handleProfileData({method, headers: {}, body, query: {}} as any, res, {
    db, sendPreflight: () => false, requireAllowedHost: () => true, setCorsHeaders: () => undefined,
    corsHandler: (_q: any, _s: any, f: any) => {
      pending = f();
    },
    requireIdToken: async () => ({decoded: {uid}}),
  });
  await pending;
  return out;
}

function ctx(db: any) {
  const logger = {info: () => undefined, warn: () => undefined, error: () => undefined};
  return {firestore: db, now: new Date(), dryRun: false, workspace: {} as any, config: {} as any, logger};
}

beforeEach(() => {
  sheet.headers = ["ID", "imię", "nazwisko", "telefon", "data urodzenia", "Rola", "Status"];
  sheet.rows = [{"ID": "12", "imię": "Jan", "nazwisko": "Kowalski", "telefon": "600 100 200", "data urodzenia": "01.05.1990", "Rola": "Członek", "Status": "Zawieszony"}];
  sheet.writes = [];
});

describe("edycja własnych danych", () => {
  it("GET zwraca dane; POST waliduje", async () => {
    const {db} = seed();
    expect((await call(db, "A", "GET")).body).toMatchObject({firstName: "Jan", lastName: "Kowalski", phone: "600 100 200"});
    expect((await call(db, "A", "POST", {firstName: "Jan", lastName: "", phone: "600100200"})).status).toBe(400);
    expect((await call(db, "A", "POST", {firstName: "Jan", lastName: "K", phone: "123"})).status).toBe(400);
  });

  it("POST: baza + job; job wpisuje do arkusza tylko zmienione komórki (Rola/Status nietknięte)", async () => {
    const {fake, db} = seed();
    const r = await call(db, "A", "POST", {firstName: "  Jan  ", lastName: "Nowak-Kowalski", phone: "+48  601 000 000", dateOfBirth: "1990-05-01"});
    expect(r.body).toMatchObject({ok: true, changed: true, sheet: "queued", lastName: "Nowak-Kowalski", phone: "+48 601 000 000"});
    const u = (fake.dump("users_active") as any[]).find((x) => x._docId === "A" || x.email === "a@x.pl");
    expect(u.profile).toMatchObject({firstName: "Jan", lastName: "Nowak-Kowalski", phone: "+48 601 000 000"});
    const jobs = fake.dump("service_jobs") as any[];
    expect(jobs.map((j) => [j.taskId, j.payload.uid])).toEqual([["members.updateProfileInSheet", "A"]]);

    const res = await membersUpdateProfileInSheetTask.run({uid: "A"}, ctx(db));
    expect(res.ok).toBe(true);
    expect(sheet.writes).toEqual([{row: 2, patch: {"nazwisko": "Nowak-Kowalski", "telefon": "+48 601 000 000"}, mode: "RAW"}]);
    expect(sheet.rows[0]).toMatchObject({"Rola": "Członek", "Status": "Zawieszony"});

    await membersUpdateProfileInSheetTask.run({uid: "A"}, ctx(db));
    expect(sheet.writes.length).toBe(1); // już aktualne
  });

  it("bez zmian → bez joba; konto testowe / bez ID → bez arkusza", async () => {
    const {fake, db} = seed([
      {_docId: "T", email: "tester@x.pl", memberId: 99, profile: {firstName: "T", lastName: "T", phone: "600100200", dateOfBirth: "1990-01-01"}},
      {_docId: "N", email: "n@x.pl", profile: {firstName: "N", lastName: "N", phone: "600100200", dateOfBirth: "1990-01-01"}},
    ]);
    expect((await call(db, "A", "POST", {firstName: "Jan", lastName: "Kowalski", phone: "600 100 200", dateOfBirth: "1990-05-01"})).body).toMatchObject({changed: false});
    expect((await call(db, "T", "POST", {firstName: "Tom", lastName: "T", phone: "600100200", dateOfBirth: "1990-01-01"})).body).toMatchObject({sheet: "skipped"});
    expect((await call(db, "N", "POST", {firstName: "Ola", lastName: "N", phone: "600100200", dateOfBirth: "1990-01-01"})).body).toMatchObject({sheet: "skipped"});
    expect(fake.dump("service_jobs") as any[]).toEqual([]);
  });
});

describe("data urodzenia", () => {
  const L = {min: 16, adult: 18, max: 100};
  it("checkBirthDate: format, przyszłość, < 16, 16–17 warunkowo, > 100", () => {
    expect(ageOn("2008-11-04", "2026-11-04")).toBe(18);
    expect(ageOn("2008-11-05", "2026-11-04")).toBe(17);
    expect(checkBirthDate("2008-11-04", "2026-11-04", L)).toMatchObject({ok: true, code: "adult"});
    expect(checkBirthDate("2010-11-04", "2026-11-04", L)).toMatchObject({ok: true, code: "minor", age: 16});
    expect(checkBirthDate("2010-11-05", "2026-11-04", L)).toMatchObject({ok: false, code: "too_young", age: 15});
    expect(checkBirthDate("1925-01-01", "2026-11-04", L)).toMatchObject({ok: false, code: "too_old"});
    expect(checkBirthDate("2027-01-01", "2026-11-04", L).code).toBe("cannot_be_future");
    expect(checkBirthDate("2001-02-30", "2026-11-04", L).code).toBe("invalid_format");
  });

  it("POST: < 16 lat odrzucone z komunikatem; 16–17 → zapis + job maila do Zarządu (raz)", async () => {
    const {fake, db} = seed();
    const young = await call(db, "A", "POST", {firstName: "Jan", lastName: "Kowalski", phone: "600 100 200", dateOfBirth: "2020-01-01"});
    expect(young.status).toBe(400);
    expect(young.body.error).toMatch(/ukończyła 16 lat/);
    const old = await call(db, "A", "POST", {firstName: "Jan", lastName: "Kowalski", phone: "600 100 200", dateOfBirth: "1900-01-01"});
    expect(old.body.error).toMatch(/powyżej 100 lat/);

    const y = Number(new Date().toISOString().slice(0, 4)) - 17;
    const minor = await call(db, "A", "POST", {firstName: "Jan", lastName: "Kowalski", phone: "600 100 200", dateOfBirth: `${y}-01-01`});
    expect(minor.body).toMatchObject({ok: true, birthDate: {code: "minor", ok: true}});
    expect(minor.body.birthDate.message).toMatch(/zgody Zarządu/);
    expect((fake.dump("service_jobs") as any[]).map((j) => j.taskId).sort()).toEqual(["members.updateProfileInSheet", "users.notifyMinorMember"]);

    const sent: any[] = [];
    const c: any = {...ctx(db), workspace: {sendGenericEmail: async (to: string, subject: string, body: string) => {
      sent.push({to, subject, body});
    }}};
    await usersNotifyMinorMemberTask.run({uid: "A"}, c);
    await usersNotifyMinorMemberTask.run({uid: "A"}, c);
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe("zarzad@morzkulc.pl");
    expect(sent[0].subject).toMatch(/Osoba niepełnoletnia w aplikacji — Jan Kowalski \(17 lat\)/);
  });
});
