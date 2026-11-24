/**
 * Ranking „Najczęściej używany sprzęt” dla członków (E4, 24.11.2026):
 * dostęp poza sympatykiem/zawieszonym, osoby jako ksywa / imię + inicjał, bez e-maili i uid.
 */
import {describe, it, expect} from "vitest";
import {handleGetAdminGearTopRentals} from "../src/api/getAdminGearTopRentalsHandler";
import {FakeFirestore} from "./helpers/fake_firestore";

function seed() {
  return new FakeFirestore({
    users_active: [
      {_docId: "m1", role_key: "rola_czlonek", status_key: "status_aktywny", email: "m1@x.pl", profile: {firstName: "Jan", lastName: "Kowalski"}},
      {_docId: "m2", role_key: "rola_czlonek", status_key: "status_aktywny", email: "m2@x.pl", profile: {nickname: "Harry", firstName: "G", lastName: "Ż"}},
      {_docId: "s1", role_key: "rola_sympatyk", status_key: "status_aktywny"},
      {_docId: "z1", role_key: "rola_czlonek", status_key: "status_zawieszony"},
      {_docId: "a1", role_key: "rola_zarzad", status_key: "status_aktywny"},
    ],
    gear_reservations: [
      {_docId: "r1", status: "active", userUid: "m1", userEmail: "m1@x.pl", startDate: "2026-11-02", endDate: "2026-11-03",
        items: [{category: "kayaks", itemNumber: "12", itemLabel: "Dagger Mamba"}]},
    ],
    basen_kayak_allocations: [
      {_docId: "b1", sessionId: "2026-11-10", kayakId: "k12", uid: "m2", slot: "A"},
    ],
    gear_kayaks: [{_docId: "k12", number: "12", brand: "Dagger", model: "Mamba"}],
  }).asDb();
}

function call(db: any, uid: string, audience?: "admin" | "members"): Promise<{code: number; body: any}> {
  return new Promise((resolve) => {
    const res: any = {code: 200, status(c: number) {
      this.code = c; return this;
    }, json(b: any) {
      resolve({code: this.code, body: b});
    }};
    handleGetAdminGearTopRentals({method: "GET", query: {range: "custom", from: "2026-11-01", to: "2026-11-30"}, headers: {}} as any, res, {
      db, sendPreflight: () => false, requireAllowedHost: () => true, setCorsHeaders: () => undefined,
      corsHandler: (_q: any, _r: any, f: any) => f(), requireIdToken: async () => ({decoded: {uid}}),
      adminRoleKeys: ["rola_zarzad", "rola_kr"], audience,
    });
  });
}

describe("top rentals — widok członków", () => {
  it("sympatyk i zawieszony → 403", async () => {
    expect((await call(seed(), "s1", "members")).code).toBe(403);
    expect((await call(seed(), "z1", "members")).code).toBe(403);
  });

  it("członek widzi ranking z basenem, osoby bez nazwisk/e-maili/uid", async () => {
    const {code, body} = await call(seed(), "m1", "members");
    expect(code).toBe(200);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({number: "12", totalDays: 3});
    const people = body.rows[0].rentals.map((r: any) => r.userName).sort();
    expect(people).toEqual(["Harry", "Jan K."]);
    for (const r of body.rows[0].rentals) {
      expect(r.userEmail).toBe("");
      expect(r.userUid).toBe("");
      expect(r.userNick).toBe("");
    }
  });

  it("tryb admin bez zmian: członek → 403, zarząd widzi pełne dane", async () => {
    expect((await call(seed(), "m1")).code).toBe(403);
    const {body} = await call(seed(), "a1");
    const jan = body.rows[0].rentals.find((r: any) => r.userUid === "m1");
    expect(jan).toMatchObject({userName: "Jan Kowalski", userEmail: "m1@x.pl"});
  });
});
