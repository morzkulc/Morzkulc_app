// READ-ONLY: mapa debugowa słownika km_places — wszystkie miejsca ze współrzędnymi + listy kontrolne.
// Generuje LOKALNY plik HTML (nic nie jest wdrażane do aplikacji) i otwiera go w przeglądarce.
//
// Pokazuje:
//   - pinezki wszystkich miejsc (kolor wg źródła: import historyczny / wpis z aplikacji),
//     rozmiar wg useCount; popup: nazwa, id, useCount, waterType, źródło, współrzędne, aliasy,
//   - listę z wyszukiwarką (klik → przybliżenie),
//   - kontrolę: miejsca bez współrzędnych, różne nazwy w tym samym punkcie (< ~100 m),
//     nazwy różniące się tylko wielkością liter.
//
// URUCHOMIENIE (Windows, inspekcja SSL → wymagana flaga):
//   node --use-system-ca functions/scripts/kmPlacesDebugMap.js [ścieżka.html]
//   domyślnie: %TEMP%\km_places_debug_map.html

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const admin = require("firebase-admin");

const OUT = process.argv[2] || path.join(os.tmpdir(), "km_places_debug_map.html");
admin.initializeApp({ projectId: "morzkulc-e9df7" });
const db = admin.firestore();

(async () => {
  const snap = await db.collection("km_places").get();
  const places = snap.docs.map((d) => {
    const p = d.data();
    return {
      id: d.id,
      name: String(p.name || ""),
      lat: typeof p.lat === "number" ? p.lat : null,
      lng: typeof p.lng === "number" ? p.lng : null,
      useCount: Number(p.useCount || 0),
      waterType: p.waterType || "",
      source: p.source === "historical_import" ? "historical_import" : "runtime",
      aliases: Array.isArray(p.aliases) ? p.aliases : [],
    };
  }).sort((a, b) => a.name.localeCompare(b.name, "pl"));

  const noCoords = places.filter((p) => p.lat == null);
  const sameSpot = new Map();
  places.filter((p) => p.lat != null).forEach((p) => {
    const k = p.lat.toFixed(3) + "," + p.lng.toFixed(3);
    sameSpot.set(k, [...(sameSpot.get(k) || []), p.name]);
  });
  const shared = [...sameSpot].filter(([, n]) => n.length > 1).map(([k, n]) => ({ at: k, names: n }));
  const byLower = new Map();
  places.forEach((p) => byLower.set(p.name.toLowerCase(), [...(byLower.get(p.name.toLowerCase()) || []), p.name]));
  const caseDupes = [...byLower.values()].filter((n) => n.length > 1);

  const data = { generatedAt: new Date().toISOString(), places, noCoords: noCoords.map((p) => p.name), shared, caseDupes };
  fs.writeFileSync(OUT, html(data), "utf8");
  console.log(`Miejsc: ${places.length} | ze współrzędnymi: ${places.length - noCoords.length} | bez: ${noCoords.length} | wspólny punkt: ${shared.length} | duplikaty wielkości liter: ${caseDupes.length}`);
  console.log("Zapisano:", OUT);
  if (process.platform === "win32") execFile("cmd", ["/c", "start", "", OUT]);
})().catch((e) => { console.error(e.message); process.exit(1); });

function html(data) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Słownik km_places — debug</title>
<link rel="stylesheet" href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css">
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<style>
  :root { --bg:#0b0f17; --panel:#101828; --text:#e6e8ee; --muted:#9aa3b2; --border:#263042; --hist:#4f8cff; --rt:#ff9d3c; --warn:#f5b84b; }
  * { box-sizing:border-box; } body { margin:0; font:13px system-ui,sans-serif; background:var(--bg); color:var(--text); display:flex; height:100vh; }
  #side { width:340px; flex-shrink:0; overflow:auto; background:var(--panel); border-right:1px solid var(--border); padding:12px; }
  #map { flex:1; } h1 { font-size:15px; margin:0 0 4px; } h2 { font-size:13px; margin:14px 0 6px; color:var(--warn); }
  .muted { color:var(--muted); } input { width:100%; padding:7px 9px; margin:8px 0; border-radius:8px; border:1px solid var(--border); background:#0b1220; color:var(--text); }
  .row { padding:4px 6px; border-radius:6px; cursor:pointer; display:flex; justify-content:space-between; gap:8px; } .row:hover { background:#1b2436; }
  .dot { display:inline-block; width:9px; height:9px; border-radius:50%; margin-right:6px; } .legend span { margin-right:12px; }
  ul { margin:0; padding-left:18px; } li { margin:2px 0; }
  .maplibregl-popup-content { color:#111; font:12px system-ui,sans-serif; }
  @media (max-width: 720px) { body { flex-direction:column; } #side { width:100%; height:45vh; } }
</style></head><body>
<div id="side">
  <h1>Słownik km_places</h1>
  <div class="muted" id="meta"></div>
  <div class="legend" style="margin-top:6px"><span><i class="dot" style="background:var(--hist)"></i>import historyczny</span><span><i class="dot" style="background:var(--rt)"></i>z aplikacji</span></div>
  <div id="checks"></div>
  <h2 style="color:var(--text)">Wszystkie miejsca</h2>
  <input id="q" placeholder="Szukaj nazwy…">
  <div id="list"></div>
</div>
<div id="map"></div>
<script>
const D = ${json};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
// Ten sam podkład co mapa w aplikacji (OpenFreeMap, bez klucza). Kafelki OSM odrzucały
// żądania z pliku („Access denied"), CARTO żądało klucza API.
const withCoords = D.places.filter((p) => p.lat != null);
const map = new maplibregl.Map({ container: "map", style: "https://tiles.openfreemap.org/styles/positron", center: [15, 52], zoom: 4 });
map.addControl(new maplibregl.NavigationControl());
const byId = new Map(D.places.map((p) => [p.id, p]));
const popupHtml = (p) => "<b>" + esc(p.name) + "</b><br>id: " + esc(p.id) + "<br>useCount: " + p.useCount + "<br>waterType: " + esc(p.waterType || "—") +
  "<br>źródło: " + (p.source === "historical_import" ? "import historyczny" : "aplikacja") + "<br>" + p.lat + ", " + p.lng +
  (p.aliases.length ? "<br>aliasy: " + esc(p.aliases.join(", ")) : "");
const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px" });
map.on("load", () => {
  map.addSource("places", { type: "geojson", data: { type: "FeatureCollection", features: withCoords.map((p) => ({
    type: "Feature", geometry: { type: "Point", coordinates: [p.lng, p.lat] },
    properties: { id: p.id, name: p.name, hist: p.source === "historical_import" ? 1 : 0, r: 4 + Math.min(10, Math.log2(1 + p.useCount)) },
  })) } });
  map.addLayer({ id: "places", type: "circle", source: "places", paint: {
    "circle-radius": ["get", "r"], "circle-color": ["case", ["==", ["get", "hist"], 1], "#4f8cff", "#ff9d3c"],
    "circle-opacity": 0.6, "circle-stroke-width": 1.5, "circle-stroke-color": "#1b2436",
  } });
  map.addLayer({ id: "labels", type: "symbol", source: "places", minzoom: 7, layout: {
    "text-field": ["get", "name"], "text-size": 11, "text-offset": [0, 1.2], "text-anchor": "top", "text-font": ["Noto Sans Regular"],
  }, paint: { "text-color": "#1b2436", "text-halo-color": "#fff", "text-halo-width": 1.2 } });
  map.on("click", "places", (e) => {
    const p = byId.get(e.features[0].properties.id);
    popup.setLngLat([p.lng, p.lat]).setHTML(popupHtml(p)).addTo(map);
  });
  map.on("mouseenter", "places", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "places", () => { map.getCanvas().style.cursor = ""; });
  if (withCoords.length) {
    const b = new maplibregl.LngLatBounds();
    withCoords.forEach((p) => b.extend([p.lng, p.lat]));
    map.fitBounds(b, { padding: 30, maxZoom: 9 });
  }
});
document.getElementById("meta").textContent = "Wygenerowano " + D.generatedAt.slice(0, 16).replace("T", " ") + " UTC · " + D.places.length + " miejsc, " + withCoords.length + " ze współrzędnymi";
const sec = (title, items) => items.length ? "<h2>" + title + " (" + items.length + ")</h2><ul>" + items.map((i) => "<li>" + i + "</li>").join("") + "</ul>" : "";
document.getElementById("checks").innerHTML =
  sec("Bez współrzędnych — brak na mapie", D.noCoords.map(esc)) +
  sec("Różne nazwy w tym samym punkcie", D.shared.map((s) => esc(s.names.join(" · ")) + " <span class=muted>" + s.at + "</span>")) +
  sec("Nazwy różniące się wielkością liter", D.caseDupes.map((n) => esc(n.join(" · "))));
const list = document.getElementById("list");
function renderList(q) {
  const ql = q.trim().toLowerCase();
  list.innerHTML = D.places.filter((p) => !ql || p.name.toLowerCase().includes(ql)).map((p) =>
    '<div class="row" data-id="' + esc(p.id) + '"><span><i class="dot" style="background:' + (p.source === "historical_import" ? "var(--hist)" : "var(--rt)") + '"></i>' +
    esc(p.name) + (p.lat == null ? ' <span style="color:var(--warn)">brak wsp.</span>' : "") + '</span><span class="muted">' + p.useCount + "</span></div>").join("");
}
list.addEventListener("click", (e) => {
  const row = e.target.closest(".row"); if (!row) return;
  const p = byId.get(row.dataset.id); if (!p || p.lat == null) return;
  map.flyTo({ center: [p.lng, p.lat], zoom: 11 });
  popup.setLngLat([p.lng, p.lat]).setHTML(popupHtml(p)).addTo(map);
});
document.getElementById("q").addEventListener("input", (e) => renderList(e.target.value));
renderList("");
</script></body></html>`;
}
