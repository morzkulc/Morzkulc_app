// Buduje słownik km_places z historycznych wpisów km_logs (sourceType != "runtime").
// Import archiwum (archiwum_sync.gs) nie zasila km_places — audyt S9 / §4.7 — więc historyczne
// nazwy nie trafiały do podpowiedzi, a słownik nie znał ich współrzędnych.
//
// Zasady (dane 12.10.2026: 249 nazw, każda z jedną parą współrzędnych i jednym waterType):
//   - nazwa jest już w słowniku (porównanie bez wielkości liter) → uzupełnia TYLKO brakujące
//     lat/lng/waterType i dolicza liczbę wpisów historycznych do useCount; nazwy nie zmienia,
//   - nowa nazwa → nowy dokument (name, searchTerms, lat/lng, waterType, useCount = liczba
//     wpisów historycznych, source = "historical_import"),
//   - idempotentny: uruchomienie ponownie nie dolicza useCount drugi raz (znacznik historyImportedAt).
//
// URUCHOMIENIE (Windows, inspekcja SSL → wymagana flaga; wymaga `npm --prefix functions run build`):
//   node --use-system-ca functions/scripts/kmBuildPlacesFromHistory.js          — podgląd (nic nie zapisuje)
//   node --use-system-ca functions/scripts/kmBuildPlacesFromHistory.js --apply  — zapis
// Po zapisie przebuduj mapę (km.rebuildMapData).

const admin = require("firebase-admin");
const { tokenizeName } = require("../lib/modules/km/km_places_service");

const APPLY = process.argv.includes("--apply");
admin.initializeApp({ projectId: "morzkulc-e9df7" });
const db = admin.firestore();

(async () => {
  const [logsSnap, placesSnap] = await Promise.all([
    db.collection("km_logs").get(),
    db.collection("km_places").get(),
  ]);

  const placeByLower = new Map();
  placesSnap.docs.forEach((d) => placeByLower.set(String(d.data().name || "").trim().toLowerCase(), d));

  const hist = new Map(); // nazwa → {n, lat, lng, waterType}
  for (const d of logsSnap.docs) {
    const l = d.data();
    if (l.sourceType === "runtime") continue;
    if (l.visibility === "hidden" || l.deletedAt != null) continue;
    const name = String(l.placeName || "").trim();
    if (!name || typeof l.lat !== "number" || typeof l.lng !== "number") continue;
    const g = hist.get(name) || { n: 0, lat: l.lat, lng: l.lng, waterType: l.waterType || null };
    g.n++;
    hist.set(name, g);
  }

  const now = admin.firestore.Timestamp.now();
  const creates = [];
  const updates = [];
  for (const [name, g] of hist) {
    const existing = placeByLower.get(name.toLowerCase());
    if (!existing) {
      const ref = db.collection("km_places").doc();
      creates.push({ ref, doc: {
        placeId: ref.id, name, aliases: [], searchTerms: tokenizeName(name),
        waterType: g.waterType, country: null, lat: g.lat, lng: g.lng,
        useCount: g.n, source: "historical_import", historyImportedAt: now, createdAt: now, updatedAt: now,
      } });
      continue;
    }
    const p = existing.data();
    const upd = {};
    if (typeof p.lat !== "number" || typeof p.lng !== "number") { upd.lat = g.lat; upd.lng = g.lng; }
    if (!p.waterType && g.waterType) upd.waterType = g.waterType;
    if (!p.historyImportedAt) { upd.useCount = admin.firestore.FieldValue.increment(g.n); upd.historyImportedAt = now; }
    if (Object.keys(upd).length) {
      upd.updatedAt = now;
      updates.push({ ref: existing.ref, name: p.name, upd, hist: name, n: g.n });
    }
  }

  console.log(`Historyczne nazwy: ${hist.size} | nowe miejsca: ${creates.length} | uzupełnienia istniejących: ${updates.length}`);
  updates.forEach((u) => console.log(`  ~ ${u.name} ← „${u.hist}" (${u.n} wpisów): ${Object.keys(u.upd).filter((k) => k !== "updatedAt").join(", ")}`));
  creates.slice(0, 10).forEach((c) => console.log(`  + ${c.doc.name} (${c.doc.useCount}) ${c.doc.lat},${c.doc.lng}`));
  if (creates.length > 10) console.log(`  + … i ${creates.length - 10} kolejnych`);

  if (!APPLY) { console.log("\nPODGLĄD — nic nie zapisano. Zapis: --apply"); return; }

  const ops = [...creates.map((c) => (b) => b.set(c.ref, c.doc)), ...updates.map((u) => (b) => b.update(u.ref, u.upd))];
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach((op) => op(batch));
    await batch.commit();
  }
  console.log(`\nZAPISANO: ${creates.length} nowych, ${updates.length} uzupełnionych.`);
})().catch((e) => { console.error(e.message); process.exit(1); });
