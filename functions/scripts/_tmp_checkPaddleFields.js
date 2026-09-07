// READ-ONLY diagnostic: sprawdza lengthCm/featherAngle na gear_paddles w prod.
const admin = require("firebase-admin");
admin.initializeApp({ projectId: "morzkulc-e9df7" });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("gear_paddles").limit(10).get();
  const out = [];
  snap.forEach((d) => {
    const x = d.data() || {};
    out.push({
      id: d.id,
      number: x.number,
      lengthCm: x.lengthCm,
      featherAngle: x.featherAngle,
      hasLengthField: Object.prototype.hasOwnProperty.call(x, "lengthCm"),
      hasFeatherField: Object.prototype.hasOwnProperty.call(x, "featherAngle"),
      updatedAt: x.updatedAt && x.updatedAt.toDate ? x.updatedAt.toDate().toISOString() : null,
    });
  });
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(2);
});
