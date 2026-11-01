// Start modułu Basen od zera (decyzja 01.11.2026): kasuje WSZYSTKIE dane basenu —
// terminy, zapisy, przydziały kajaków, listę rezerwową, zamówienia, saldo godzin basenowych
// oraz konta demo (users_active demo_basen_*). Przed kasowaniem zapisuje kopię JSON.
//
// Domyślnie DRY-RUN. Użycie (z katalogu functions/):
//   node --use-system-ca scripts/resetBasenData.js
//   node --use-system-ca scripts/resetBasenData.js --execute --backup <plik.json>
const fs = require("fs");
const admin = require("firebase-admin");

admin.initializeApp({projectId: "morzkulc-e9df7"});
const db = admin.firestore();

const EXECUTE = process.argv.includes("--execute");
const backupIdx = process.argv.indexOf("--backup");
const BACKUP = backupIdx > 0 ? process.argv[backupIdx + 1] : null;

const COLLECTIONS = [
  "basen_sessions",
  "basen_enrollments",
  "basen_kayak_allocations",
  "basen_waitlist",
  "basen_orders",
  "basen_godziny_ledger",
];

(async () => {
  console.log(EXECUTE ? "=== TRYB WYKONANIA ===" : "=== DRY-RUN (dodaj --execute aby wykonać) ===");
  if (EXECUTE && !BACKUP) throw new Error("Przy --execute podaj --backup <plik.json>");

  const backup = {};
  const toDelete = [];
  for (const name of COLLECTIONS) {
    const snap = await db.collection(name).get();
    backup[name] = snap.docs.map((d) => ({_id: d.id, ...d.data()}));
    toDelete.push(...snap.docs.map((d) => d.ref));
    console.log(`${name}: ${snap.size}`);
  }
  const demo = await db.collection("users_active")
    .where(admin.firestore.FieldPath.documentId(), ">=", "demo_basen_")
    .where(admin.firestore.FieldPath.documentId(), "<", "demo_basen_")
    .get();
  backup.users_active_demo = demo.docs.map((d) => ({_id: d.id, ...d.data()}));
  toDelete.push(...demo.docs.map((d) => d.ref));
  console.log(`users_active demo_basen_*: ${demo.size}`);

  if (!EXECUTE) {
    console.log(`\nDo usunięcia: ${toDelete.length} (dry-run, nic nie zapisano)`);
    process.exit(0);
  }

  fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 1));
  console.log(`Kopia: ${BACKUP}`);
  for (let i = 0; i < toDelete.length; i += 400) {
    const batch = db.batch();
    toDelete.slice(i, i + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  console.log(`Usunięto: ${toDelete.length}`);
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(2);
});
