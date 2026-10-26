// Rejestr Blach := oficjalne archiwum klubowe do 2025 r. (src/modules/blachy/blachy_archiwum_2025.ts).
// - zapisuje wpisy archiwum jako `archiwum_<poz>` (zrodlo archiwum_2025, bez edycji w aplikacji),
// - przenosi z pasujących starych wpisów tylko e-mail / ID członka (dopasowanie procedury) i „ś.p.",
// - usuwa wszystkie inne wpisy z rokiem ≤ 2025 albo bez roku (sprzeczne z archiwum).
// Wymaga zbudowanego lib/: npm --prefix functions run build
// Podgląd:  node --use-system-ca functions/scripts/importBlachyArchiwum2025.js
// Zapis:    node --use-system-ca functions/scripts/importBlachyArchiwum2025.js --apply
const path = require("path");
const admin = require("firebase-admin");
const {ARCHIWUM_2025, ARCHIWUM_DO_ROKU} = require(path.join(__dirname, "../lib/modules/blachy/blachy_archiwum_2025"));
const {personKey} = require(path.join(__dirname, "../lib/modules/blachy/blachy_registry"));

const APPLY = process.argv.includes("--apply");

// Ta sama osoba zapisana w bilansie otwarcia innym imieniem / nazwiskiem (poz archiwum → id wpisu).
const MATCH_OVERRIDES = {5: "bo_49", 6: "bo_52", 17: "bo_85", 22: "bo_110", 28: "bo_244"};
// Bilans: Marcin Ardanowski miał e-mail tomasz@gromadzcy.pl (nie jego) — nie przenosimy.
const DROP_EMAIL = {7: true};

admin.initializeApp({projectId: "morzkulc-e9df7"});
const db = admin.firestore();

(async () => {
  const col = db.collection("blachy");
  const docs = (await col.get()).docs.map((d) => ({id: d.id, d: d.data()}));
  const old = docs.filter((x) => x.d.zrodlo !== "archiwum_2025");
  const used = new Set();
  const writes = [];

  for (const a of ARCHIWUM_2025) {
    const id = `archiwum_${String(a.poz).padStart(2, "0")}`;
    const key = personKey(a.imie, a.nazwisko);
    const m = MATCH_OVERRIDES[a.poz] ?
      old.find((x) => x.id === MATCH_OVERRIDES[a.poz]) :
      old.find((x) => !used.has(x.id) && personKey(x.d.imie, x.d.nazwisko) === key);
    if (m) used.add(m.id);
    const prev = docs.find((x) => x.id === id)?.d || {};
    const email = DROP_EMAIL[a.poz] ? "" : String(prev.email || m?.d.email || "").trim().toLowerCase();
    const doc = {
      imie: a.imie, nazwisko: a.nazwisko, ksywa: a.ksywa,
      rok: a.data ? Number(a.data.slice(0, 4)) : null, nr: a.nr, honorowa: a.honorowa,
      data: a.data, miejsce: a.miejsce, okazja: a.okazja,
      uzasadnienie: String(prev.uzasadnienie || m?.d.uzasadnienie || ""), klub: "", zalozycielska: "",
      sp: prev.sp === true || m?.d.sp === true,
      email, memberId: prev.memberId ?? m?.d.memberId ?? null,
      zrodlo: "archiwum_2025", poz: a.poz,
    };
    writes.push({id, doc, from: m ? `${m.id} (${m.d.imie} ${m.d.nazwisko}, rok ${m.d.rok ?? "?"})` : "—"});
  }

  const toDelete = old.filter((x) => used.has(x.id) || x.d.rok == null || Number(x.d.rok) <= ARCHIWUM_DO_ROKU);
  const kept = old.filter((x) => !toDelete.includes(x));

  for (const w of writes) {
    const nr = w.doc.honorowa ? "Hon." : (w.doc.nr == null ? "—" : String(w.doc.nr).padStart(2, "0"));
    console.log(`${w.id}  nr ${nr}  ${w.doc.data || "?"}  ${w.doc.imie} ${w.doc.nazwisko} „${w.doc.ksywa}”${w.doc.sp ? " ś.p." : ""}  ${w.doc.email || "-"}  ← ${w.from}`);
  }
  console.log(`\nUSUWANE (${toDelete.length}), w tym bez odpowiednika w archiwum:`);
  for (const x of toDelete.filter((x) => !used.has(x.id))) console.log(`  ${x.id}  ${x.d.imie} ${x.d.nazwisko} „${x.d.ksywa || ""}” rok ${x.d.rok ?? "?"}`);
  console.log(`ZOSTAJĄ (po ${ARCHIWUM_DO_ROKU}): ${kept.map((x) => x.id).join(", ") || "—"}`);

  if (!APPLY) {
    console.log("\nPODGLĄD — nic nie zapisano. Zapis: --apply");
    return;
  }
  const ts = admin.firestore.FieldValue.serverTimestamp();
  const batch = db.batch();
  for (const w of writes) {
    const exists = docs.some((x) => x.id === w.id);
    batch.set(col.doc(w.id), {...w.doc, ...(exists ? {} : {createdAt: ts}), updatedAt: ts, updatedBy: "importBlachyArchiwum2025"}, {merge: true});
  }
  for (const x of toDelete) batch.delete(col.doc(x.id));
  await batch.commit();
  console.log(`\nZAPISANO: ${writes.length} wpisów archiwum, usunięto ${toDelete.length}.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
