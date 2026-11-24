/**
 * Basen w raportach wypożyczeń (24.11.2026): 1 termin = 1 dzień, bez kajaków
 * własnych ("PRIVATE") i prywatnych (isPrivate), „pół na pół” liczony normalnie.
 */
import {describe, it, expect} from "vitest";
import {buildBasenKayakUsage, loadBasenKayakUsage} from "../src/modules/basen/basen_usage";
import {FakeFirestore} from "./helpers/fake_firestore";

const kayaks = new Map<string, any>([
  ["k1", {number: "12", brand: "Dagger", model: "Mamba"}],
  ["k2", {number: "30", brand: "Prywatny", model: "X", isPrivate: true}],
  ["k3", {number: "40", brand: "Pyranha", model: "Z", isHalfHalf: true}],
]);

describe("buildBasenKayakUsage", () => {
  it("dwa sloty tego samego dnia, ta sama osoba i kajak = 1 użycie", () => {
    const out = buildBasenKayakUsage([
      {sessionId: "2026-11-10", kayakId: "k1", uid: "u1"},
      {sessionId: "2026-11-10", kayakId: "k1", uid: "u1"},
    ], kayaks);
    expect(out).toEqual([{date: "2026-11-10", kayakId: "k1", number: "12", label: "Dagger Mamba", uid: "u1"}]);
  });

  it("różne dni / różne osoby = osobne użycia", () => {
    const out = buildBasenKayakUsage([
      {sessionId: "2026-11-10", kayakId: "k1", uid: "u1"},
      {sessionId: "2026-11-17", kayakId: "k1", uid: "u1"},
      {sessionId: "2026-11-17", kayakId: "k1", uid: "u2"},
    ], kayaks);
    expect(out).toHaveLength(3);
  });

  it("pomija PRIVATE i isPrivate, liczy pół na pół", () => {
    const out = buildBasenKayakUsage([
      {sessionId: "2026-11-10", kayakId: "PRIVATE", uid: "u1"},
      {sessionId: "2026-11-10", kayakId: "k2", uid: "u2"},
      {sessionId: "2026-11-10", kayakId: "k3", uid: "u3"},
    ], kayaks);
    expect(out.map((u) => u.number)).toEqual(["40"]);
  });

  it("kajak nieznaleziony w gear_kayaks → numer = id, bez nazwy", () => {
    const out = buildBasenKayakUsage([{sessionId: "2026-11-10", kayakId: "k9", uid: "u1"}], kayaks);
    expect(out[0]).toMatchObject({number: "k9", label: ""});
  });
});

describe("loadBasenKayakUsage — zakres dat", () => {
  it("bierze tylko terminy z [from, to]", async () => {
    const db = new FakeFirestore({
      basen_kayak_allocations: [
        {_docId: "a1", sessionId: "2026-10-31", kayakId: "k1", uid: "u1"},
        {_docId: "a2", sessionId: "2026-11-01", kayakId: "k1", uid: "u1"},
        {_docId: "a3", sessionId: "2026-11-30", kayakId: "k1", uid: "u2"},
        {_docId: "a4", sessionId: "2026-12-01", kayakId: "k1", uid: "u1"},
      ],
      gear_kayaks: [{_docId: "k1", number: "12", brand: "Dagger", model: "Mamba"}],
    }).asDb();
    const out = await loadBasenKayakUsage(db as any, "2026-11-01", "2026-11-30");
    expect(out.map((u) => u.date).sort()).toEqual(["2026-11-01", "2026-11-30"]);
  });
});
