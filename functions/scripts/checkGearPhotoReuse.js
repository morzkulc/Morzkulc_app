// Zdjęcia „odziedziczone” po złomowanej sztuce (Storage adresuje zdjęcia NUMEREM).
// Domyślnie READ-ONLY — raport. Naprawa tylko wskazanych ID:
//   node --use-system-ca functions/scripts/checkGearPhotoReuse.js
//   node --use-system-ca functions/scripts/checkGearPhotoReuse.js --apply --ids=kayaks:12,helmets:40
// --ids = ID ZŁOMOWANYCH dokumentów (kryterium A). Wymaga zbudowanego functions/lib.
const path = require("path");
const admin = require("firebase-admin");
const {archiveGearPhotos, photoTargets} = require(path.join(__dirname, "../lib/modules/equipment/shared/gear_photos_archive"));

admin.initializeApp({projectId: "morzkulc-e9df7", storageBucket: "morzkulc-e9df7.firebasestorage.app"});
const db = admin.firestore();
const bucket = admin.storage().bucket();

const CATS = [
  {key: "kayaks", collection: "gear_kayaks"},
  {key: "helmets", collection: "gear_helmets"},
  {key: "lifejackets", collection: "gear_lifejackets"},
];

const toDate = (v) => (v && typeof v.toDate === "function" ? v.toDate() : null);
const day = (d) => (d ? d.toISOString().slice(0, 10) : "—");
const label = (x) => [x.brand, x.model].filter(Boolean).join(" ") || "—";

async function storageFiles(catKey, number) {
  const t = photoTargets(catKey, number);
  if (!t) return [];
  if (t.kind === "prefix") {
    const [files] = await bucket.getFiles({prefix: t.prefix});
    return files.filter((f) => !f.name.endsWith("/"));
  }
  const out = [];
  for (const p of t.paths) {
    const f = bucket.file(p);
    const [exists] = await f.exists();
    if (exists) {
      await f.getMetadata();
      out.push(f);
    }
  }
  return out;
}

(async () => {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const idsArg = (args.find((a) => a.startsWith("--ids=")) || "").slice(6);
  const applyIds = new Set(idsArg.split(",").map((s) => s.trim()).filter(Boolean));

  for (const cat of CATS) {
    const snap = await db.collection(cat.collection).get();
    const docs = snap.docs.map((d) => ({id: d.id, ...d.data()}));
    const active = docs.filter((x) => x.gearScrapped !== true);
    const scrapped = docs.filter((x) => x.gearScrapped === true);
    const activeByNr = new Map(active.filter((x) => x.number).map((x) => [String(x.number).trim(), x]));

    console.log(`\n=== ${cat.key}: aktywne ${active.length}, złomowane ${scrapped.length}`);

    // A: złomowana sztuka z tym samym numerem co aktywna
    console.log("-- A: złomowana i aktywna pod tym samym numerem");
    for (const old of scrapped) {
      if (/demo/i.test(`${old.brand || ""} ${old.model || ""}`)) continue; // kopie testowe (moduł basenowy)
      const nr = String(old.number || "").trim();
      const cur = nr && activeByNr.get(nr);
      if (!cur) continue;
      const files = await storageFiles(cat.key, nr);
      console.log(`nr ${nr} | złom ID ${old.id} ${label(old)} (złom. ${day(toDate(old.scrappedAt))}) | aktywny ID ${cur.id} ${label(cur)} (od ${day(toDate(cur.createdAt))}) | plików: ${files.length}`);
      if (apply && applyIds.has(`${cat.key}:${old.id}`)) {
        const res = await archiveGearPhotos({bucket, categoryKey: cat.key, id: old.id, number: nr, dateIso: new Date().toISOString().slice(0, 10), dryRun: false});
        await db.collection(cat.collection).doc(old.id).update({photosArchivedTo: res.moved.map((m) => m.to)});
        console.log(`   PRZENIESIONO ${res.moved.length}: ${res.moved.map((m) => m.to).join(", ")}`);
      }
    }

    // B: aktywna sztuka ze zdjęciami starszymi niż jej dokument
    console.log("-- B: aktywne ze zdjęciami starszymi niż dokument");
    for (const cur of active) {
      const nr = String(cur.number || "").trim();
      if (!nr) continue;
      const files = await storageFiles(cat.key, nr);
      if (!files.length) continue;
      const created = toDate(cur.createdAt);
      const times = files.map((f) => new Date(f.metadata.timeCreated));
      const oldest = new Date(Math.min(...times));
      if (!created) {
        console.log(`nr ${nr} | ID ${cur.id} ${label(cur)} | BRAK createdAt | najstarsze zdjęcie ${day(oldest)}`);
      } else if (oldest < created) {
        const older = times.filter((t) => t < created).length;
        console.log(`nr ${nr} | ID ${cur.id} ${label(cur)} | dokument od ${day(created)} | zdjęć starszych: ${older}/${files.length} (najstarsze ${day(oldest)})`);
      }
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
