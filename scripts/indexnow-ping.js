/**
 * IndexNow — zgłasza URL-e z wygenerowanej sitemap (Bing/Copilot/DuckDuckGo, Yandex, Seznam).
 * postdeploy targetu Hosting w firebase.json. Błąd nie przerywa deployu (tylko ostrzeżenie).
 * Klucz = plik <32 hex>.txt w katalogu źródłowym strony.
 *
 * Użycie: node scripts/indexnow-ping.js kurs|www
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TARGETS = {
  kurs: {src: "site_kurs", out: ".build/site_kurs", host: "kurs.morzkulc.pl"},
  www: {src: "site_www", out: ".build/site_www", host: "morzkulc.pl"},
};

async function main() {
  const cfg = TARGETS[process.argv[2]];
  if (!cfg) throw new Error("nieznany target: " + process.argv[2]);
  const keyFile = fs.readdirSync(path.join(ROOT, cfg.src)).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  if (!keyFile) throw new Error("brak pliku klucza w " + cfg.src);
  const key = keyFile.slice(0, -4);
  const xml = fs.readFileSync(path.join(ROOT, cfg.out, "sitemap.xml"), "utf8");
  const urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const res = await fetch("https://api.indexnow.org/indexnow", {
    method: "POST",
    headers: {"Content-Type": "application/json; charset=utf-8"},
    body: JSON.stringify({host: cfg.host, key, keyLocation: `https://${cfg.host}/${keyFile}`, urlList}),
  });
  console.log(`[indexnow] ${cfg.host}: ${urlList.length} URL → HTTP ${res.status}`);
}

main().catch((e) => console.warn("[indexnow] OSTRZEŻENIE: " + (e && e.message || e)));
