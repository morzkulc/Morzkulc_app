/**
 * Dane demonstracyjne modułu Basen na prod — do obejrzenia panelu opiekunów basenu
 * (kalendarz, Finanse, Płatności → „Do zatwierdzenia"). Moduł jest wtedy wyłączony dla
 * ludzi (modul_6 access.mode=off, widzą go tylko testUsersAllow).
 *
 * Osoby demo: uid demo_basen_NN, e-maile @example.com (googleWorkspaceProvider pomija
 * wysyłkę na tę domenę). Brak dokumentów w users_active — nic nie trafia do grup,
 * arkusza członków ani raportów członkowskich.
 *
 * Uruchomienie (z functions/):
 *   node --use-system-ca scripts/seedBasenDemo.js            — podgląd
 *   node --use-system-ca scripts/seedBasenDemo.js --apply    — zapis
 *   node --use-system-ca scripts/seedBasenDemo.js --purge    — usunięcie WSZYSTKICH danych demo
 *     (także zapisów powstałych z klikania w panelu: ledger/zamówienia po uid demo_basen_*,
 *      terminy z demo:true)
 */
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");
const PURGE = process.argv.includes("--purge");
admin.initializeApp({projectId: "morzkulc-e9df7"});
const db = admin.firestore();
const TS = (iso) => admin.firestore.Timestamp.fromDate(new Date(iso));

const PREFIX = "demo_basen_";
const NAMES = [
  "Anna Kowalska", "Bartek Nowak", "Celina Wiśniewska", "Darek Wójcik", "Ewa Kamińska", "Filip Lewandowski",
  "Gosia Zielińska", "Hubert Szymański", "Iza Woźniak", "Janek Dąbrowski", "Kasia Kozłowska", "Leszek Jankowski",
  "Magda Mazur", "Norbert Krawczyk", "Ola Piotrowska (instr.)", "Paweł Grabowski (instr.)",
];
const people = NAMES.map((n, i) => {
  const nn = String(i + 1).padStart(2, "0");
  return {uid: PREFIX + nn, name: `${n} DEMO`, email: `demo${nn}@example.com`};
});
const P = (i) => people[i - 1];

// Zakup każdej osoby (FIFO wycenia godzinę basenową po cenie z zakupu).
const PURCHASES = {
  1: "karnet10", 2: "karnet10", 3: "karnet5", 4: "karnet5", 5: "jednorazowe", 6: "karnet10", 7: "jednorazowe",
  8: "karnet5", 9: "karnet10", 10: "jednorazowe", 11: "karnet5", 12: "karnet10", 13: "jednorazowe", 14: "karnet5",
};
const PRICE = {jednorazowe: {n: 4, unit: 35, amount: 140}, karnet5: {n: 5, unit: 28, amount: 140}, karnet10: {n: 10, unit: 24.5, amount: 245}};
const LABEL = {
  jednorazowe: (n) => `Godziny basenowe pojedyncze × ${n} (${n * 35} zł)`,
  karnet5: () => "Karnet 5 godzin basenowych (140 zł)",
  karnet10: () => "Karnet 10 godzin basenowych (245 zł)",
};

// Terminy: [data, H1 (osoby), H2 (osoby), instruktorzy H1, opis]
// Uczestnik z „T" = szuka instruktora / sparowany z instruktorem.
const SESSIONS = [
  {date: "2026-10-15", h1: [1, 2, 3, 4, 5, 6, 7, 8], h2: [9, 10, 11, 12, 13, 14], instr: [], kind: "held"},
  {date: "2026-10-20", zapisy: 5, kind: "cancelledLow"},
  {date: "2026-10-27", h1: [1, 2, 3, 9, 11, 12, 14], h2: [4, 6, 8, 13, 10], instr: [15], training: {h1: [[3, 15]]}, kind: "held"},
  {date: "2026-11-03", h1: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], h2: [13, 14], instr: [15, 16], training: {h1: [[7, 15], [8, null]]}, waitlist: [13, 14], kind: "planned"},
  {date: "2026-11-05", h1: [1, 2, 6, 9, 11, 12], h2: [3, 4, 5, 8, 10, 14], instr: [], kind: "planned"},
  {date: "2026-11-12", h1: [2, 6, 9], h2: [11, 12], instr: [16], kind: "planned"},
];

const ORDERS = [
  {who: 3, product: "karnet10", status: "pending", at: "2026-10-27T18:10:00Z"},
  {who: 5, product: "karnet5", status: "pending", at: "2026-10-28T09:30:00Z"},
  {who: 7, product: "jednorazowe", count: 3, status: "pending", at: "2026-10-28T20:05:00Z"},
  {who: 13, product: "jednorazowe", count: 1, status: "pending", at: "2026-10-29T07:45:00Z"},
  {who: 10, product: "karnet10", status: "pending", at: "2026-10-29T08:20:00Z"},
  {who: 1, product: "karnet10", status: "approved", at: "2026-10-01T10:00:00Z"},
  {who: 8, product: "jednorazowe", count: 2, status: "rejected", rejectReason: "brak wpłaty po 7 dniach", at: "2026-10-10T10:00:00Z"},
  {who: 4, product: "karnet5", status: "cancelled", at: "2026-10-12T10:00:00Z"},
];

function slot(timeStart, timeEnd, count, cancelled) {
  return {timeStart, timeEnd, capacity: 12, enrolledCount: count, status: cancelled ? "cancelled" : "open"};
}

function build() {
  const docs = []; // [collection, id, data]
  const put = (c, id, data) => docs.push([c, id, {...data, demo: true}]);

  // Zakupy (sprzedaż na początku października).
  for (const [i, product] of Object.entries(PURCHASES)) {
    const p = P(Number(i));
    const pr = PRICE[product];
    put("basen_godziny_ledger", `${PREFIX}buy_${i}`, {
      id: `${PREFIX}buy_${i}`, uid: p.uid, type: "admin_add", amount: pr.n, product, unitPricePln: pr.unit, amountPln: pr.amount,
      ...(product !== "jednorazowe" ? {validUntil: "2027-03-31"} : {}),
      reason: `${LABEL[product](pr.n)} — DEMO`, performedBy: "demo", createdAt: TS("2026-10-02T10:00:00Z"), updatedAt: TS("2026-10-02T10:00:00Z"),
    });
  }

  for (const s of SESSIONS) {
    const notes = "DEMO";
    if (s.kind === "cancelledLow") {
      put("basen_sessions", s.date, {
        id: s.date, date: s.date, notes, costPln: 350, cancelReason: "frekwencja",
        slots: {H1: slot("21:00", "21:45", 0, true), H2: slot("21:45", "22:30", 0, true)},
        decision: {status: "cancelled", at: TS(`${s.date}T14:00:00Z`), zapisy: s.zapisy, entries: s.zapisy, valuePln: 150, costPln: 350, resultPln: -200, seasonNetPln: 0, light: "red"},
        createdBy: "demo", createdAt: TS("2026-10-01T10:00:00Z"), updatedAt: TS(`${s.date}T14:00:00Z`),
      });
      continue;
    }
    const trainingBySlot = {H1: new Map((s.training?.h1 || []).map(([w, ins]) => [w, ins]))};
    const lists = {H1: s.h1, H2: s.h2};
    for (const label of ["H1", "H2"]) {
      for (const w of lists[label]) {
        const p = P(w);
        const id = `${s.date}_${label}_${p.uid}`;
        const isTraining = trainingBySlot[label]?.has(w);
        const instr = isTraining ? trainingBySlot[label].get(w) : null;
        const product = PURCHASES[w];
        const valuePln = PRICE[product].unit;
        put("basen_enrollments", id, {
          id, sessionId: s.date, slot: label, userUid: p.uid, userEmail: p.email, userDisplayName: p.name,
          type: isTraining ? "training" : "regular", instructorUid: instr ? P(instr).uid : null,
          chargedGodziny: true, valuePln, status: "active", createdAt: TS("2026-10-05T10:00:00Z"), updatedAt: TS("2026-10-05T10:00:00Z"),
        });
        put("basen_godziny_ledger", `${PREFIX}blk_${id}`, {
          id: `${PREFIX}blk_${id}`, uid: p.uid, type: "booking_block", amount: -1, valuePln, reason: "Zapis na basen",
          sessionId: s.date, slot: label, enrollmentId: id, performedBy: p.uid, createdAt: TS("2026-10-05T10:00:00Z"), updatedAt: TS("2026-10-05T10:00:00Z"),
        });
      }
    }
    for (const w of s.instr || []) {
      const p = P(w);
      const id = `${s.date}_H1_${p.uid}`;
      put("basen_enrollments", id, {
        id, sessionId: s.date, slot: "H1", userUid: p.uid, userEmail: p.email, userDisplayName: p.name,
        type: "instructor", instructorUid: null, chargedGodziny: false, valuePln: 0, status: "active",
        createdAt: TS("2026-10-05T10:00:00Z"), updatedAt: TS("2026-10-05T10:00:00Z"),
      });
    }
    for (const w of s.waitlist || []) {
      const p = P(w);
      const id = `${s.date}_H1_${p.uid}`;
      put("basen_waitlist", id, {
        id, sessionId: s.date, slot: "H1", userUid: p.uid, userEmail: p.email, userDisplayName: p.name, status: "waiting",
        createdAt: TS("2026-10-28T10:00:00Z"), updatedAt: TS("2026-10-28T10:00:00Z"),
      });
    }
    const zapisy = s.h1.length + s.h2.length;
    const valuePln = [...s.h1, ...s.h2].reduce((sum, w) => sum + PRICE[PURCHASES[w]].unit, 0);
    put("basen_sessions", s.date, {
      id: s.date, date: s.date, notes, costPln: 350,
      slots: {H1: slot("21:00", "21:45", s.h1.length, false), H2: slot("21:45", "22:30", s.h2.length, false)},
      ...(s.kind === "held" ? {decision: {status: "confirmed", at: TS(`${s.date}T14:00:00Z`), zapisy, entries: zapisy, valuePln, costPln: 350, resultPln: valuePln - 350, seasonNetPln: 0, light: valuePln >= 350 ? "green" : "yellow"}} : {}),
      createdBy: "demo", createdAt: TS("2026-10-01T10:00:00Z"), updatedAt: TS("2026-10-05T10:00:00Z"),
    });
  }

  ORDERS.forEach((o, i) => {
    const p = P(o.who);
    const id = `${PREFIX}order_${i + 1}`;
    const pr = o.product === "jednorazowe" ? {n: o.count, unit: 35, amount: o.count * 35} : PRICE[o.product];
    const what = o.product === "jednorazowe" ? `${pr.n} godz` : `karnet ${o.product === "karnet5" ? 5 : 10}`;
    put("basen_orders", id, {
      id, uid: p.uid, userEmail: p.email, userName: p.name, product: o.product, count: pr.n, unitPricePln: pr.unit, amountPln: pr.amount,
      label: LABEL[o.product](pr.n), transferTitle: `Basen ${what} ${p.name} ${id.slice(-6).toUpperCase()}`, status: o.status,
      ...(o.rejectReason ? {rejectReason: o.rejectReason} : {}),
      ...(o.status !== "pending" ? {decidedBy: "demo", decidedAt: TS(o.at)} : {}),
      createdAt: TS(o.at), updatedAt: TS(o.at),
    });
  });
  return docs;
}

async function purge() {
  const targets = [];
  for (const c of ["basen_godziny_ledger", "basen_orders"]) {
    const s = await db.collection(c).where("uid", ">=", PREFIX).where("uid", "<", PREFIX + "").get();
    s.docs.forEach((d) => targets.push(d.ref));
  }
  for (const c of ["basen_enrollments", "basen_waitlist"]) {
    const s = await db.collection(c).where("userUid", ">=", PREFIX).where("userUid", "<", PREFIX + "").get();
    s.docs.forEach((d) => targets.push(d.ref));
  }
  const ses = await db.collection("basen_sessions").where("demo", "==", true).get();
  ses.docs.forEach((d) => targets.push(d.ref));
  console.log(`Do usunięcia: ${targets.length} dokumentów`);
  if (!APPLY && !PURGE) return;
  for (let i = 0; i < targets.length; i += 400) {
    const b = db.batch();
    targets.slice(i, i + 400).forEach((r) => b.delete(r));
    await b.commit();
  }
  console.log("Usunięto.");
}

(async () => {
  if (PURGE) return purge();
  const docs = build();
  const byCol = {};
  docs.forEach(([c]) => (byCol[c] = (byCol[c] || 0) + 1));
  console.log(`${APPLY ? "ZAPIS" : "PODGLĄD"}:`, byCol);
  const existing = await db.collection("basen_sessions").where("demo", "==", true).get();
  if (!existing.empty) throw new Error("Dane demo już istnieją — najpierw --purge.");
  if (!APPLY) return;
  for (let i = 0; i < docs.length; i += 400) {
    const b = db.batch();
    docs.slice(i, i + 400).forEach(([c, id, data]) => b.set(db.collection(c).doc(id), data));
    await b.commit();
  }
  console.log("Zapisano.");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
