/**
 * Naprawa pól users_active zapisanych dosłownie z kropką w nazwie (np. "service.kmHistMergeEnqueued"
 * na najwyższym poziomie zamiast service.kmHistMergeEnqueued). Przyczyna: set({"service.x": v}, {merge})
 * — set traktuje kropkę dosłownie (w przeciwieństwie do update). Kod poprawiony 28.10.2026.
 *
 * Dla każdego takiego pola: wartość przenoszona do mapy (o ile zagnieżdżone pole jeszcze nie istnieje),
 * pole dosłowne usuwane. Domyślnie DRY RUN; zapis: --apply.
 *
 * Uruchomienie (z functions/): node --use-system-ca scripts/fixDottedServiceFields.js [--apply]
 */
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");
admin.initializeApp({projectId: "morzkulc-e9df7"});
const db = admin.firestore();
const {FieldPath, FieldValue} = admin.firestore;

(async () => {
  const snap = await db.collection("users_active").get();
  let users = 0;
  let fields = 0;
  for (const doc of snap.docs) {
    const data = doc.data();
    const dotted = Object.keys(data).filter((k) => k.includes("."));
    if (!dotted.length) continue;
    users++;
    const args = [];
    for (const k of dotted) {
      const i = k.indexOf(".");
      const top = k.slice(0, i);
      const sub = k.slice(i + 1);
      if (data[top]?.[sub] === undefined) args.push(new FieldPath(top, sub), data[k]);
      args.push(new FieldPath(k), FieldValue.delete());
      fields++;
    }
    console.log(`${APPLY ? "FIX" : "DRY"} ${doc.id} ${data.email || ""}: ${dotted.join(", ")}`);
    if (APPLY) await doc.ref.update(...args);
  }
  console.log(`${APPLY ? "Naprawiono" : "Do naprawy"}: ${users} użytkowników, ${fields} pól`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
