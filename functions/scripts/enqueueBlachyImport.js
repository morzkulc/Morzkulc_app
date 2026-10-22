// Import blach sprzed aplikacji z bilansu otwarcia do Rejestru Blach (task blachy.importOpeningBalance).
// Istniejących wpisów nie nadpisuje — bezpieczny do ponownego uruchomienia.
// node --use-system-ca functions/scripts/enqueueBlachyImport.js [--dry]
const admin = require("firebase-admin");

const BO_SHEET_ID = "1dJpaV3OdFHo1ugD_NzSaysXbQyp_HkQe2EVpCiBVDac"; // 4_Bilans Otwarcia 2026
const BO_TAB = "bilans otwarcia 26";

const dry = process.argv.slice(2).includes("--dry");

admin.initializeApp({ projectId: "morzkulc-e9df7" });
const db = admin.firestore();

(async () => {
  const id = `manual-blachy-import-${Date.now()}`;
  const ref = db.collection("service_jobs").doc(id);
  await ref.set({
    taskId: "blachy.importOpeningBalance",
    payload: { spreadsheetId: BO_SHEET_ID, tabName: BO_TAB, dry },
    status: "queued",
    attempts: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`CREATED job id: ${id} (dry=${dry})`);

  for (let i = 0; i < 36; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const data = (await ref.get()).data() || {};
    if (data.status === "done" || data.status === "dead") {
      console.log(JSON.stringify(data.result || data.lastError || data, null, 2));
      process.exit(data.status === "done" ? 0 : 1);
    }
  }
  console.log("TIMEOUT po 3 minutach — sprawdź service_jobs/" + id);
  process.exit(1);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(2);
});
