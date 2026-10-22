// Usuwa martwe pole users_active.admin.badge (blachy są w kolekcji `blachy` — Rejestr Blach, 22.10.2026).
// node --use-system-ca functions/scripts/removeAdminBadge.js [--dry]
const admin = require("firebase-admin");

const dry = process.argv.slice(2).includes("--dry");
admin.initializeApp({ projectId: "morzkulc-e9df7" });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("users_active").get();
  const hits = snap.docs.filter((d) => d.data()?.admin && Object.prototype.hasOwnProperty.call(d.data().admin, "badge"));
  for (const d of hits) {
    console.log(`${d.data().email} badge=${JSON.stringify(d.data().admin.badge)}`);
    if (!dry) await d.ref.update({ "admin.badge": admin.firestore.FieldValue.delete() });
  }
  console.log(`${dry ? "DO USUNIĘCIA" : "USUNIĘTO"}: ${hits.length}`);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
