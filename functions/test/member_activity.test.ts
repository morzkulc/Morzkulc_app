/**
 * Raport „Najbardziej aktywni" (getAdminMemberActivity): pula bilansu otwarcia
 * (approvedBy="opening_balance") ma grantedAt = 01.04.2026 (OPENING_BALANCE_DATE),
 * więc wchodzi do zakresu „rok", a nie do „semestru" (od 12.04.2026 wzwyż).
 * Plus widok członka GET /api/godzinki?view=ranking (ostatni semestr, bez e-maili).
 *
 * Uruchamianie: npm --prefix functions run test
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore, ts} from "./helpers/fake_firestore";
import {handleGetAdminMemberActivity} from "../src/api/getAdminMemberActivityHandler";
import {handleGetGodzinki} from "../src/api/getGodzinkiHandler";

const profile = (firstName: string, lastName: string) => ({firstName, lastName});

function seed(): FakeFirestore {
  return new FakeFirestore({
    users_active: [
      {_docId: "admin", role_key: "rola_zarzad", profile: profile("Ad", "Min")},
      {_docId: "anna", role_key: "rola_czlonek", email: "anna@x.pl", profile: profile("Anna", "Nowak")},
      {_docId: "bob", role_key: "rola_czlonek", email: "bob@x.pl", profile: profile("Bob", "Kowal")},
      {_docId: "sym", role_key: "rola_sympatyk", email: "sym@x.pl", profile: profile("Sym", "Patyk")},
    ],
    godzinki_ledger: [
      {uid: "anna", type: "earn", approved: true, amount: 100, approvedBy: "opening_balance", grantedAt: ts("2026-04-01T00:00:00Z")},
      {uid: "bob", type: "earn", approved: true, amount: 40, approvedBy: "opening_balance", grantedAt: ts("2026-04-01T00:00:00Z")},
      // Zwykła praca w semestrze.
      {uid: "anna", type: "earn", approved: true, amount: 5, approvedBy: "zarzad@x.pl", grantedAt: ts("2026-07-01T00:00:00Z")},
      {uid: "bob", type: "earn", approved: true, amount: 8, approvedBy: "zarzad@x.pl", grantedAt: ts("2026-08-01T00:00:00Z")},
    ],
  });
}

function fakeRes() {
  const out: {status: number; body: any} = {status: 0, body: null};
  const res: any = {
    status(s: number) {
      out.status = s;
      return res;
    },
    json(b: any) {
      out.body = b;
      return res;
    },
  };
  return {out, res};
}

async function runRanking(db: FakeFirestore, uid: string) {
  const {out, res} = fakeRes();
  let inner: Promise<void> = Promise.resolve();
  await handleGetGodzinki({method: "GET", query: {view: "ranking"}} as any, res, {
    db: db as any,
    sendPreflight: () => false,
    requireAllowedHost: () => true,
    setCorsHeaders: () => undefined,
    corsHandler: (_req: any, _res: any, next: () => Promise<void>) => {
      inner = next();
    },
    requireIdToken: async () => ({decoded: {uid}}),
    godzinkiRoleKeys: ["rola_czlonek", "rola_zarzad", "rola_kr", "rola_kandydat"],
  });
  await inner;
  return out;
}

async function run(db: FakeFirestore, query: Record<string, string>) {
  let status = 0;
  let body: any = null;
  const res: any = {
    status(s: number) {
      status = s;
      return res;
    },
    json(b: any) {
      body = b;
      return res;
    },
  };
  // Handler nie await-uje callbacku corsHandler — czekamy na niego sami.
  let inner: Promise<void> = Promise.resolve();
  await handleGetAdminMemberActivity({method: "GET", query} as any, res, {
    db: db as any,
    sendPreflight: () => false,
    requireAllowedHost: () => true,
    setCorsHeaders: () => undefined,
    corsHandler: (_req: any, _res: any, next: () => Promise<void>) => {
      inner = next();
    },
    requireIdToken: async () => ({decoded: {uid: "admin"}}),
    adminRoleKeys: ["rola_zarzad", "rola_kr"],
  });
  await inner;
  return {status, body};
}

const hoursOf = (body: any) => Object.fromEntries(body.rows.map((r: any) => [r.userUid, r.hours]));

describe("getAdminMemberActivity — bilans otwarcia jako 01.04.2026", () => {
  it("zakres bez 01.04.2026 (semestr) → BO pominięty", async () => {
    const {status, body} = await run(seed(), {range: "custom", from: "2026-04-12", to: "2026-10-12"});
    expect(status).toBe(200);
    expect(hoursOf(body)).toEqual({anna: 5, bob: 8});
  });

  it("zakres obejmujący 01.04.2026 (rok) → BO doliczony", async () => {
    const {body} = await run(seed(), {range: "custom", from: "2025-10-12", to: "2026-10-12"});
    expect(hoursOf(body)).toEqual({anna: 105, bob: 48});
    expect(body.rows[0].userUid).toBe("anna");
  });
});

describe("GET /api/godzinki?view=ranking — widok członka", () => {
  it("członek widzi ranking semestru bez e-maili i uid, ze swoim wierszem oznaczonym", async () => {
    // Semestr jest kroczący (dziś − 6 mies.) — wpis sprzed 10 dni zawsze w nim jest.
    const db = seed();
    const recent = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    await db.collection("godzinki_ledger").doc("recent").set({uid: "anna", type: "earn", approved: true, amount: 3, grantedAt: ts(recent + "T00:00:00Z")});
    const {status, body} = await runRanking(db, "anna");
    expect(status).toBe(200);
    expect(body.range.key).toBe("semester");
    for (const r of body.rows) {
      expect(Object.keys(r).sort()).toEqual(["hours", "isMe", "name", "rank"]);
    }
    expect(body.rows.find((r: any) => r.isMe)?.name).toBe("Anna Nowak");
    // Bilans otwarcia (01.04.2026) nigdy nie wchodzi do semestru liczonego od dziś.
    expect(body.rows.find((r: any) => r.isMe)?.hours).toBeLessThan(100);
  });

  it("rola bez dostępu do godzinek (sympatyk) → 403", async () => {
    const {status} = await runRanking(seed(), "sym");
    expect(status).toBe(403);
  });
});
