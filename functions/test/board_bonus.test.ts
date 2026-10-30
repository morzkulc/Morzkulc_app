/**
 * Bonus miesięczny za pełnioną funkcję: zarząd i KR mają osobne wartości (decyzja 30.10.2026).
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {creditBoardMonthlyBonus} from "../src/service/tasks/godzinkiMonthlyBalanceReview";

describe("creditBoardMonthlyBonus", () => {
  it("zarząd 10 h, KR 2 h, z rolą w wpisie; drugie uruchomienie w tym samym miesiącu nic nie dubluje", async () => {
    const fake = new FakeFirestore({users_active: [
      {_docId: "Z", role_key: "rola_zarzad"},
      {_docId: "K", role_key: "rola_kr"},
      {_docId: "C", role_key: "rola_czlonek"},
    ]});
    const db = fake.asDb();
    const now = new Date("2026-11-01T06:00:00Z");
    expect(await creditBoardMonthlyBonus(db, now, {rola_zarzad: 10, rola_kr: 2}, 48, false)).toBe(2);
    expect(await creditBoardMonthlyBonus(db, now, {rola_zarzad: 10, rola_kr: 2}, 48, false)).toBe(0);
    const byUid = Object.fromEntries(fake.dump("godzinki_ledger").map((r: any) => [r.uid, r]));
    expect(byUid.Z).toMatchObject({amount: 10, bonusRole: "rola_zarzad"});
    expect(byUid.K).toMatchObject({amount: 2, bonusRole: "rola_kr"});
    expect(byUid.C).toBeUndefined();
  });
});
