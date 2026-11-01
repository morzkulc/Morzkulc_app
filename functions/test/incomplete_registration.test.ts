/**
 * Niedokończone rejestracje: jedno przypomnienie po 3 dniach od założenia konta, usunięcie po 7 dniach;
 * konta starsze w chwili wysyłki dostają 7 dni od maila; usuwane tylko dane dodane automatycznie.
 */
import {describe, it, expect, vi} from "vitest";
import {FakeFirestore, ts} from "./helpers/fake_firestore";

const deletedAuth: string[] = [];
vi.mock("firebase-admin", async (orig) => {
  const real: any = await orig();
  const auth = () => ({deleteUser: async (uid: string) => {
    deletedAuth.push(uid);
  }});
  const firestore = real.firestore ?? real.default?.firestore;
  return {...real, firestore, auth, default: {...(real.default || real), firestore, auth}};
});

import {deletionDeadline, usersIncompleteRegistrationTask} from "../src/service/tasks/usersIncompleteRegistration";

const DAY = 24 * 3600 * 1000;
const full = {firstName: "A", lastName: "B", phone: "1", dateOfBirth: "2000-01-01", consentRodo: true, consentStatute: true};
const ago = (d: number) => ts(new Date(Date.now() - d * DAY).toISOString());

function ctx(db: FakeFirestore, sent: string[]) {
  const logger = {info: () => undefined, warn: () => undefined, error: () => undefined};
  const workspace = {sendGenericEmail: async (to: string) => {
    sent.push(to);
  }};
  return {firestore: db as any, now: new Date(), dryRun: false, workspace: workspace as any, config: {} as any, logger};
}

describe("termin usunięcia", () => {
  it("nowe konto: założenie + 7 dni; konto starsze niż 7 dni: 7 dni od maila", () => {
    const now = Date.UTC(2026, 10, 1);
    expect(deletionDeadline(now - 3 * DAY, now, 3, 7)).toBe(now + 4 * DAY);
    expect(deletionDeadline(now - 60 * DAY, now, 3, 7)).toBe(now + 7 * DAY);
  });
});

describe("users.incompleteRegistration", () => {
  it("przypomina raz po 3 dniach, pomija kompletne, świeże, admin@ i konta testowe", async () => {
    const db = new FakeFirestore({
      setup: [{_docId: "vars_members", vars: {konta_testowe: {value: "test@x.pl"}}}],
      users_active: [
        {_docId: "ok", email: "ok@x.pl", profile: full, createdAt: ago(30)},
        {_docId: "new", email: "new@x.pl", profile: {}, createdAt: ago(1)},
        {_docId: "d5", email: "d5@x.pl", profile: {}, createdAt: ago(5)},
        {_docId: "old", email: "old@x.pl", profile: {}, createdAt: ago(60)},
        {_docId: "adm", email: "admin@morzkulc.pl", profile: {}, createdAt: ago(100)},
        {_docId: "tst", email: "test@x.pl", profile: {}, createdAt: ago(100)},
      ],
    });
    const sent: string[] = [];
    const r = await usersIncompleteRegistrationTask.run({}, ctx(db, sent));
    expect(sent.sort()).toEqual(["d5@x.pl", "old@x.pl"]);
    expect((r.details as any).reminded).toBe(2);
    const users = db.dump("users_active") as any[];
    const d5 = users.find((u) => u.email === "d5@x.pl").service.registrationDeleteAfter.toMillis();
    const old = users.find((u) => u.email === "old@x.pl").service.registrationDeleteAfter.toMillis();
    // mail dopiero 5. dnia (np. przy wdrożeniu) → pełne 7 dni od maila; 3. dzień → 7 dni od założenia (test terminu wyżej)
    expect(Math.round((d5 - Date.now()) / DAY)).toBe(7);
    expect(Math.round((old - Date.now()) / DAY)).toBe(7);
    // drugi przebieg — bez kolejnych maili
    const again: string[] = [];
    await usersIncompleteRegistrationTask.run({}, ctx(db, again));
    expect(again).toEqual([]);
  });

  it("po terminie usuwa konto z danymi automatycznymi (bilans, km historyczne wracają do archiwum); z ręcznymi danymi pomija", async () => {
    deletedAuth.length = 0;
    const past = ago(1);
    const db = new FakeFirestore({
      users_active: [
        {_docId: "mm", email: "mm@x.pl", profile: {}, createdAt: ago(70), service: {registrationDeleteAfter: past, kmHistMergedFrom: "hist_mm@x.pl"}},
        {_docId: "keep", email: "keep@x.pl", profile: {}, createdAt: ago(70), service: {registrationDeleteAfter: past}},
      ],
      godzinki_ledger: [
        {_docId: "g1", uid: "mm", type: "earn", amount: 10, reason: "Bilans otwarcia"},
        {_docId: "g2", uid: "keep", type: "earn", amount: 2, reason: "sprzątanie"},
      ],
      km_logs: [{_docId: "k1", uid: "mm", sourceType: "historical", km: 15}],
      km_user_stats: [{_docId: "mm", allTimeKm: 15}],
    });
    const sent: string[] = [];
    const r = await usersIncompleteRegistrationTask.run({}, ctx(db, sent));
    expect(r.details).toMatchObject({deleted: 1, skippedWithData: 1, deletedEmails: ["mm@x.pl"]});
    expect((db.dump("users_active") as any[]).map((u) => u.email)).toEqual(["keep@x.pl"]);
    expect((db.dump("godzinki_ledger") as any[]).map((g) => g.uid)).toEqual(["keep"]);
    expect((db.dump("km_logs") as any[])[0].uid).toBe("hist_mm@x.pl");
    expect(db.dump("km_user_stats")).toEqual([]);
    expect(deletedAuth).toEqual(["mm"]);
    expect((db.dump("service_jobs") as any[]).map((j) => j.taskId).sort()).toEqual(["km.rebuildRankings", "km.rebuildUserStats"]);
  });
});
