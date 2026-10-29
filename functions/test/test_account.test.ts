/**
 * Konto testowe (konta_testowe w Vars_MEMBERS): odczyt listy i przełącznik roli
 * POST /api/test/role — kod PRODUKCYJNY na fake Firestore.
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {getAppVars, isTestAccount} from "../src/modules/setup/app_vars";
import {handleTestAccountRole} from "../src/api/testAccountRoleHandler";

function dbWith(testAccounts: string) {
  return new FakeFirestore({
    setup: [{_docId: "vars_members", vars: {konta_testowe: {value: testAccounts}}}],
    users_active: [
      {_docId: "t1", email: "tester.test@gmail.com", role_key: "rola_sympatyk", status_key: "status_aktywny"},
      {_docId: "u1", email: "real@gmail.com", role_key: "rola_czlonek", status_key: "status_aktywny"},
    ],
  }).asDb();
}

async function call(db: any, uid: string, email: string, body: any) {
  let status = 0;
  let json: any = null;
  const res: any = {status: (s: number) => ({json: (j: any) => {
    status = s; json = j;
  }})};
  await handleTestAccountRole({method: "POST", body} as any, res, {
    db,
    sendPreflight: () => false,
    requireAllowedHost: () => true,
    setCorsHeaders: () => undefined,
    corsHandler: (_req, _res, next) => next(),
    requireIdToken: async () => ({decoded: {uid, email}}),
  });
  // corsHandler woła async callback bez await — poczekaj na jego zakończenie.
  for (let i = 0; i < 20 && !status; i++) await new Promise((r) => setTimeout(r, 5));
  return {status, json};
}

describe("konta_testowe", () => {
  it("lista po przecinku, bez wielkości liter i pustych pozycji", async () => {
    const db = dbWith(" Tester.Test@gmail.com, ,drugi@x.pl ");
    expect((await getAppVars(db)).testAccounts).toEqual(["tester.test@gmail.com", "drugi@x.pl"]);
    expect(await isTestAccount(db, "TESTER.test@gmail.com")).toBe(true);
    expect(await isTestAccount(db, "real@gmail.com")).toBe(false);
    expect((await getAppVars(new FakeFirestore().asDb())).testAccounts).toEqual([]);
  });
});

describe("POST /api/test/role", () => {
  it("zwykłe konto → 403, rola bez zmian", async () => {
    const db = dbWith("tester.test@gmail.com");
    const r = await call(db, "u1", "real@gmail.com", {roleKey: "rola_zarzad"});
    expect(r.status).toBe(403);
    expect((await db.collection("users_active").doc("u1").get()).data()?.role_key).toBe("rola_czlonek");
  });

  it("nieznana rola → 400", async () => {
    const r = await call(dbWith("tester.test@gmail.com"), "t1", "tester.test@gmail.com", {roleKey: "rola_admin"});
    expect(r.status).toBe(400);
  });

  it("konto testowe → zapis roli, status aktywny, znacznik testAccount", async () => {
    const db = dbWith("tester.test@gmail.com");
    const r = await call(db, "t1", "tester.test@gmail.com", {roleKey: "rola_zarzad"});
    expect(r).toMatchObject({status: 200, json: {ok: true, roleKey: "rola_zarzad"}});
    expect((await db.collection("users_active").doc("t1").get()).data()).toMatchObject({
      role_key: "rola_zarzad", status_key: "status_aktywny", testAccount: true,
    });
  });
});
