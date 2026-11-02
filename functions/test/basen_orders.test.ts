/**
 * Zamówienia godzin basenowych (basen_orders.ts) + reguła karnetu — kod PRODUKCYJNY
 * na fake Firestore. Karnet: pełny członek, opłacone składki, dodatnie saldo godzinek.
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore, ts} from "./helpers/fake_firestore";
import {
  approveOrder, cancelOwnOrder, createOrder, getKarnetEligibility, listPendingOrders,
  listUserOrders, rejectOrder, validateOrderInput,
} from "../src/modules/basen/basen_orders";
import {computeBasenGodzinyBalance, getBasenGodzinyRecords} from "../src/modules/basen/basen_godziny_service";
import {isDuesPaid, parseContributionsPaidUntil, parseEntryFeeMonth} from "../src/modules/users/member_standing";

const PRICING = {basen_cena_za_godzine: 35, basen_cena_karnet_5: 140, basen_cena_karnet_10: 245};

function earn(uid: string, amount: number) {
  return {id: `earn-${uid}`, uid, type: "earn", amount, remaining: amount, approved: true,
    grantedAt: ts("2026-01-01T00:00:00Z"), expiresAt: ts("2030-01-01T00:00:00Z"), reason: "seed", submittedBy: uid};
}

function user(id: string, roleKey: string, contributions?: string) {
  return {_docId: id, role_key: roleKey, status_key: "status_aktywny", email: `${id.toLowerCase()}@x.pl`,
    profile: {firstName: id, lastName: "Test"}, ...(contributions ? {admin: {contributions}} : {})};
}

function seed() {
  const fake = new FakeFirestore({
    users_active: [
      user("OK", "rola_czlonek", "2099-12-31"),
      user("NODUES", "rola_czlonek", "2020-01-01"),
      user("ZERO", "rola_czlonek", "2099-12-31"),
      user("SYMP", "rola_sympatyk"),
      user("KAND", "rola_kandydat", "2099-12-31"),
      // Kandydat: wpisowe wpłacone w bieżącym miesiącu, ale „Składki” wygasłe — wpisowe NIE liczy się osobno.
      {...user("KANDFEE", "rola_kandydat"), admin: {contributions: "2020-01-01", entryFeePaidAt: new Date().toISOString().slice(0, 7)}},
    ],
    godzinki_ledger: [earn("OK", 5), earn("NODUES", 5), earn("KAND", 5), earn("KANDFEE", 5)],
    setup: [{_docId: "vars_basen", vars: {basen_koniec_sezonu: {value: "2099-04-15"}}}],
  });
  return {fake, db: fake.asDb()};
}

async function userData(db: any, uid: string) {
  return (await db.collection("users_active").doc(uid).get()).data();
}

async function order(db: any, uid: string, product: string, count?: number) {
  return createOrder(db, {uid, userData: await userData(db, uid), userName: `${uid} Test`, product, count, pricing: PRICING});
}

describe("składki i reguła karnetu", () => {
  it("parsuje formaty dat składek", () => {
    expect(parseContributionsPaidUntil("2026-12-31")?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(parseContributionsPaidUntil("31.12.2026")?.toISOString()).toBe("2026-12-31T00:00:00.000Z");
    expect(parseContributionsPaidUntil("2026")).toBeNull();
    expect(isDuesPaid({admin: {contributions: "2026-10-29"}}, "2026-10-29")).toBe(true);
    expect(isDuesPaid({admin: {contributions: "2026-10-28"}}, "2026-10-29")).toBe(false);
  });

  it("członek ze składkami i dodatnim saldem godzinek → karnet dostępny", async () => {
    const {db} = seed();
    expect(await getKarnetEligibility(db, "OK", await userData(db, "OK"))).toMatchObject({member: true, eligible: true, reasons: []});
  });

  it("wpisowe: miesiąc wpłaty MM.RRRR; ważność tylko z „Składki” (wpisowe = 2 semestry wpisane tam)", () => {
    expect(parseEntryFeeMonth("08.2026")).toBe("2026-08");
    expect(parseEntryFeeMonth("6.2026")).toBe("2026-06");
    expect(parseEntryFeeMonth("2026-06")).toBe("2026-06");
    for (const v of ["2026", "13.2026", "01.08.2026", ""]) expect(parseEntryFeeMonth(v)).toBe("");
    expect(isDuesPaid({admin: {contributions: "2027-02-28", entryFeePaidAt: "2026-06"}}, "2026-11-01")).toBe(true);
    expect(isDuesPaid({admin: {contributions: "2026-09-30", entryFeePaidAt: "2026-06"}}, "2026-11-01")).toBe(false);
  });

  it("kandydat z wpisowym, ale wygasłymi „Składki” → karnet niedostępny (jedna zasada z profilem)", async () => {
    const {db} = seed();
    expect(await getKarnetEligibility(db, "KANDFEE", await userData(db, "KANDFEE"))).toMatchObject({member: true, eligible: false, duesPaid: false});
  });

  it("kandydat ze składkami i dodatnim saldem godzinek → karnet dostępny", async () => {
    const {db} = seed();
    expect(await getKarnetEligibility(db, "KAND", await userData(db, "KAND"))).toMatchObject({member: true, eligible: true, reasons: []});
  });

  it("brak składek / zerowe saldo → nieaktywne z powodem; nie-członek → brak kafelków", async () => {
    const {db} = seed();
    const nodues = await getKarnetEligibility(db, "NODUES", await userData(db, "NODUES"));
    expect(nodues).toMatchObject({member: true, eligible: false});
    expect(nodues.reasons.join(" ")).toMatch(/składk/);
    const zero = await getKarnetEligibility(db, "ZERO", await userData(db, "ZERO"));
    expect(zero).toMatchObject({member: true, eligible: false});
    expect(zero.reasons.join(" ")).toMatch(/godzinek/);
    expect(await getKarnetEligibility(db, "SYMP", await userData(db, "SYMP"))).toMatchObject({member: false, eligible: false});
  });
});

describe("zamówienia godzin basenowych", () => {
  it("walidacja produktu i liczby", () => {
    expect(() => validateOrderInput("karnet7", 1)).toThrow(/Wybierz produkt/);
    expect(() => validateOrderInput("jednorazowe", 0)).toThrow(/większa od 0/);
    expect(() => validateOrderInput("jednorazowe", 21)).toThrow(/najwyżej 20/);
    expect(validateOrderInput("karnet10", undefined)).toEqual({product: "karnet10", count: 0});
  });

  it("pojedyncze godziny kupuje każdy (także sympatyk); zamówienie czeka, saldo bez zmian, mail w kolejce", async () => {
    const {fake, db} = seed();
    const o = await order(db, "SYMP", "jednorazowe", 3);
    expect(o).toMatchObject({status: "pending", count: 3, amountPln: 105, unitPricePln: 35});
    expect(o.transferTitle).toMatch(/^Basen 3 godz SYMP Test [0-9A-Z_]{6}$/);
    expect(computeBasenGodzinyBalance(await getBasenGodzinyRecords(db, "SYMP"))).toBe(0);
    expect(fake.dump("service_jobs")).toEqual([expect.objectContaining({taskId: "basen.notifyOrder", payload: {orderId: o.id, kind: "created"}})]);
  });

  it("karnet bez spełnionych warunków → odmowa z powodem", async () => {
    const {db} = seed();
    await expect(order(db, "NODUES", "karnet5")).rejects.toThrow(/składk/);
    await expect(order(db, "SYMP", "karnet10")).rejects.toThrow(/członków/);
  });

  it("zatwierdzenie dopisuje godziny basenowe po cenie z zamówienia, drugi raz się nie da", async () => {
    const {db} = seed();
    const o = await order(db, "OK", "karnet5");
    await approveOrder(db, {orderId: o.id, performedBy: "ADMIN"});
    const recs = await getBasenGodzinyRecords(db, "OK");
    expect(computeBasenGodzinyBalance(recs)).toBe(5);
    expect(recs[0]).toMatchObject({type: "admin_add", product: "karnet5", amount: 5, amountPln: 140, unitPricePln: 28, orderId: o.id, performedBy: "ADMIN"});
    expect(recs[0].validUntil).toBe("2099-04-15");
    await expect(approveOrder(db, {orderId: o.id, performedBy: "ADMIN"})).rejects.toThrow(/rozpatrzone/);
    expect(await listPendingOrders(db)).toEqual([]);
  });

  it("koniec ważności karnetu z basen_koniec_sezonu w SETUP", async () => {
    const {fake, db} = seed();
    await db.collection("setup").doc("vars_basen").set({vars: {basen_koniec_sezonu: {value: "2027-04-15"}}});
    const o = await order(db, "OK", "karnet10");
    await approveOrder(db, {orderId: o.id, performedBy: "ADMIN"});
    expect((await getBasenGodzinyRecords(db, "OK"))[0].validUntil).toBe("2027-04-15");
    expect(fake.dump("basen_orders")[0]).toMatchObject({status: "approved"});
  });

  it("karnet bez końca sezonu w SETUP albo po jego upływie → niedostępny; zatwierdzenie odmawia", async () => {
    const {db} = seed();
    const o = await order(db, "OK", "karnet5");
    await db.collection("setup").doc("vars_basen").set({vars: {}});
    await expect(approveOrder(db, {orderId: o.id, performedBy: "ADMIN"})).rejects.toThrow(/basen_koniec_sezonu/);
    await expect(order(db, "OK", "karnet10")).rejects.toThrow(/basen_koniec_sezonu/);
    await db.collection("setup").doc("vars_basen").set({vars: {basen_koniec_sezonu: {value: "2020-03-31"}}});
    const el = await getKarnetEligibility(db, "OK", await userData(db, "OK"));
    expect(el.eligible).toBe(false);
    expect(el.reasons.join(" ")).toMatch(/zakończył się 2020-03-31/);
    expect((await order(db, "OK", "jednorazowe", 1)).status).toBe("pending"); // pojedyncze godziny bez zmian
  });

  it("odrzucenie wymaga powodu, kolejkuje mail; potem nie da się zatwierdzić", async () => {
    const {fake, db} = seed();
    const o = await order(db, "OK", "jednorazowe", 1);
    await expect(rejectOrder(db, {orderId: o.id, performedBy: "ADMIN", reason: " "})).rejects.toThrow(/powód/);
    await rejectOrder(db, {orderId: o.id, performedBy: "ADMIN", reason: "brak wpłaty"});
    expect(fake.dump("service_jobs").map((j: any) => j.payload.kind)).toEqual(["created", "rejected"]);
    await expect(approveOrder(db, {orderId: o.id, performedBy: "ADMIN"})).rejects.toThrow(/rozpatrzone/);
    expect((await listUserOrders(db, "OK"))[0]).toMatchObject({status: "rejected", rejectReason: "brak wpłaty"});
  });

  it("użytkownik anuluje tylko własne, niezatwierdzone zamówienie", async () => {
    const {db} = seed();
    const o = await order(db, "OK", "jednorazowe", 2);
    await expect(cancelOwnOrder(db, {uid: "SYMP", orderId: o.id})).rejects.toThrow(/nie istnieje/);
    await cancelOwnOrder(db, {uid: "OK", orderId: o.id});
    await expect(cancelOwnOrder(db, {uid: "OK", orderId: o.id})).rejects.toThrow(/niezatwierdzone/);
    await expect(approveOrder(db, {orderId: o.id, performedBy: "ADMIN"})).rejects.toThrow(/rozpatrzone/);
  });

  it("drugie zamówienie tego samego produktu, gdy pierwsze czeka → krótki komunikat; inny produkt i po anulowaniu → można", async () => {
    const {db} = seed();
    const first = await order(db, "OK", "karnet10");
    await expect(order(db, "OK", "karnet10")).rejects.toThrow(`Masz już zamówienie (${first.label}). Anuluj albo poczekaj na zatwierdzenie.`);
    const single = await order(db, "OK", "jednorazowe", 1);
    expect(single.status).toBe("pending");
    await cancelOwnOrder(db, {uid: "OK", orderId: first.id});
    expect((await order(db, "OK", "karnet10")).status).toBe("pending");
  });
});
