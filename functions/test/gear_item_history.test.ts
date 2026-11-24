/**
 * Historia wypożyczeń sztuki (E3, 24.11.2026): tylko zakończone, rok wstecz / całość,
 * osoba = ksywa albo imię + inicjał nazwiska, terminy basenowe dla kajaków.
 */
import {describe, it, expect} from "vitest";
import {selectEndedReservations} from "../src/api/getKayakReservationsHandler";
import {publicMemberName} from "../src/modules/shared/user_display";
import {loadBasenKayakHistory} from "../src/modules/basen/basen_usage";
import {FakeFirestore} from "./helpers/fake_firestore";

describe("publicMemberName", () => {
  it("ksywa ma pierwszeństwo", () => {
    expect(publicMemberName({profile: {nickname: "Harry", firstName: "Grzegorz", lastName: "Żłobiński"}})).toBe("Harry");
  });
  it("bez ksywy: imię + inicjał nazwiska (polska litera)", () => {
    expect(publicMemberName({profile: {firstName: "Grzegorz", lastName: "żłobiński"}})).toBe("Grzegorz Ż.");
  });
  it("brak danych → pusty (nigdy e-mail)", () => {
    expect(publicMemberName({email: "a@b.pl", profile: {}})).toBe("");
  });
});

describe("selectEndedReservations", () => {
  const docs = [
    {startDate: "2026-11-20", endDate: "2026-11-23", userUid: "u1"}, // kończy się dziś — nie zakończona
    {startDate: "2026-11-01", endDate: "2026-11-22", userUid: "u2"}, // zakończona wczoraj
    {startDate: "2025-11-01", endDate: "2025-11-23", userUid: "u3"}, // dokładnie rok temu
    {startDate: "2025-10-01", endDate: "2025-10-05", userUid: "u4", eventId: "e1"}, // starsza niż rok
  ];
  it("rok wstecz: tylko endDate w [from, dziś)", () => {
    const out = selectEndedReservations(docs, "2026-11-23", "2025-11-23");
    expect(out.map((r) => r.userUid)).toEqual(["u2", "u3"]);
  });
  it("cała historia: wszystkie zakończone, impreza oznaczona", () => {
    const out = selectEndedReservations(docs, "2026-11-23", "");
    expect(out.map((r) => r.userUid)).toEqual(["u2", "u3", "u4"]);
    expect(out[2]).toMatchObject({isClubEvent: true, eventId: "e1", source: "reservation"});
  });
});

describe("loadBasenKayakHistory", () => {
  const seed = () => new FakeFirestore({
    basen_kayak_allocations: [
      {_docId: "a1", sessionId: "2026-11-10", kayakId: "k1", uid: "u1"},
      {_docId: "a2", sessionId: "2026-11-10", kayakId: "k1", uid: "u1"}, // drugi slot tego dnia
      {_docId: "a3", sessionId: "2026-11-24", kayakId: "k1", uid: "u2"}, // dziś — nie zakończony
      {_docId: "a4", sessionId: "2024-01-10", kayakId: "k1", uid: "u3"}, // stary
      {_docId: "a5", sessionId: "2026-11-10", kayakId: "k2", uid: "u4"}, // inny kajak
    ],
    gear_kayaks: [{_docId: "k1", number: "12"}, {_docId: "k2", number: "13"}],
  }).asDb();

  it("tylko ta sztuka, zakończone, w zakresie; sloty jednego dnia = 1", async () => {
    const out = await loadBasenKayakHistory(seed() as any, "k1", "2025-11-24", "2026-11-24");
    expect(out.map((u) => `${u.date}/${u.uid}`)).toEqual(["2026-11-10/u1"]);
  });
  it("cała historia (from pusty)", async () => {
    const out = await loadBasenKayakHistory(seed() as any, "k1", "", "2026-11-24");
    expect(out).toHaveLength(2);
  });
});
