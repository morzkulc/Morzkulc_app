// Kolumna „Wpisowe (mm.yyyy)” (dawniej „wpisowe rok”): sam rok → miesiąc wpłaty MM.RRRR
// z admin.entryFeePaidAt w aplikacji. Zapis W ARKUSZU (tekst RAW), potem sync przenosi.
// node --use-system-ca functions/scripts/convertWpisoweToMonth.js [--apply]
const admin = require("firebase-admin");
const { google } = require("googleapis");

async function signJwt(sa, payload) {
  const auth = await google.auth.getClient({ scopes: ["https://www.googleapis.com/auth/iam"] });
  const iam = google.iamcredentials({ version: "v1", auth });
  const res = await iam.projects.serviceAccounts.signJwt({ name: "projects/-/serviceAccounts/" + sa, requestBody: { payload: JSON.stringify(payload) } });
  return res.data.signedJwt;
}
async function sheetsClient() {
  const sa = "workspace-bot@morzkulc-e9df7.iam.gserviceaccount.com";
  const iat = Math.floor(Date.now() / 1000);
  const jwt = await signJwt(sa, { iss: sa, sub: "admin@morzkulc.pl", scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt });
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error("token: " + r.status + " " + await r.text());
  const o = new google.auth.OAuth2();
  o.setCredentials({ access_token: (await r.json()).access_token });
  return google.sheets({ version: "v4", auth: o });
}
const norm = (h) => String(h || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]/g, "");
const col = (i) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };


const APPLY = process.argv.includes("--apply");
const SPREADSHEET_ID = "1lF5eDF9B6ip4G497qG1QGePXqrXdLPS8kt-3pX-ZBsM";
const TAB = "członkowie i sympatycy";

(async () => {
  admin.initializeApp({ projectId: "morzkulc-e9df7" });
  const byId = new Map((await admin.firestore().collection("users_active").get()).docs
    .map((d) => d.data()).filter((u) => u.memberId != null).map((u) => [String(u.memberId), u]));
  const sheets = await sheetsClient();
  const v = (await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${TAB}'` })).data.values;
  const H = v[0].map(norm);
  const iId = H.indexOf("id"); const iW = H.findIndex((h) => h.startsWith("wpisowe")); const iN = H.indexOf("nazwisko"); const iR = H.indexOf("rola");
  const data = [];
  for (let r = 1; r < v.length; r++) {
    const cur = String(v[r][iW] || "").trim();
    if (!cur || /^\d{2}\.\d{4}$/.test(cur)) continue;
    const id = String(v[r][iId] || "").trim();
    const u = byId.get(id);
    const m = /^(\d{4})-(\d{2})$/.exec(String(u?.admin?.entryFeePaidAt || ""));
    const next = m && m[1] === cur ? `${m[2]}.${m[1]}` : "";
    console.log(`#${id} ${v[r][iN]} (${v[r][iR]}) | „${cur}” → ${next || "?? (brak zgodnej daty wpłaty w aplikacji: " + (u?.admin?.entryFeePaidAt || "-") + ")"}`);
    if (next) data.push({ range: `'${TAB}'!${col(iW)}${r + 1}`, values: [[next]] });
  }
  console.log(`do zmiany: ${data.length}`);
  if (!APPLY) { console.log("(podgląd — uruchom z --apply)"); process.exit(0); }
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: "RAW", data } });
  console.log("ZAPISANO");
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(2); });
