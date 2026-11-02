// Kandydaci z wpisowym 2026 (wpisowe = 2 semestry: letni 2026 + zimowy 2026/27) mieli w „Składki”
// 30.09.2026 → poprawka na 28.02.2027 W ARKUSZU członków (źródło), potem sync przenosi do aplikacji.
// Zmienia tylko wiersze z „Składki” = 2026-09-30 i wpisowym wpłaconym w 2026 (entryFeePaidAt).
// node --use-system-ca functions/scripts/fixKandydaciWpisoweSkladki.js [--apply]
const admin = require("firebase-admin");
const { google } = require("googleapis");

const APPLY = process.argv.includes("--apply");
// functions/.env.morzkulc-e9df7: SVC_MEMBERS_SHEET_ID / SVC_MEMBERS_SHEET_TAB
const SPREADSHEET_ID = "1lF5eDF9B6ip4G497qG1QGePXqrXdLPS8kt-3pX-ZBsM";
const TAB = "członkowie i sympatycy";
const FROM = "2026-09-30";
const TO = "2027-02-28";

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

(async () => {
  admin.initializeApp({ projectId: "morzkulc-e9df7" });
  const kand = (await admin.firestore().collection("users_active").where("role_key", "==", "rola_kandydat").get()).docs
    .map((d) => d.data()).filter((u) => String(u?.admin?.entryFeePaidAt || "").startsWith("2026") && u?.admin?.contributions === FROM && u.memberId);
  const ids = new Set(kand.map((u) => String(u.memberId)));
  const sheets = await sheetsClient();
  const fmt = (await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${TAB}'` })).data.values;
  const raw = (await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${TAB}'`, valueRenderOption: "UNFORMATTED_VALUE" })).data.values;
  const H = fmt[0].map(norm);
  const iId = H.indexOf("id"); const iS = H.indexOf("skladki"); const iW = H.findIndex((h) => h.startsWith("wpisowe")); const iN = H.indexOf("nazwisko");
  console.log("kolumny:", { id: iId, skladki: iS, wpisowe: iW }, "nagłówek Składki:", fmt[0][iS]);
  console.log("nagłówki z 'wpis':", fmt[0].filter((h) => /wpis/i.test(h)));
  const data = [];
  for (let r = 1; r < fmt.length; r++) {
    const id = String(fmt[r][iId] || "").trim();
    if (!ids.has(id)) continue;
    const cur = String(fmt[r][iS] || "").trim();
    console.log(`#${id} ${fmt[r][iN]} | Składki: "${cur}" (raw ${JSON.stringify(raw[r] && raw[r][iS])}) | wpisowe: "${fmt[r][iW] || ""}"`);
    if (cur === FROM || cur === "30.09.2026") data.push({ range: `'${TAB}'!${col(iS)}${r + 1}`, values: [[TO]] });
    else console.log("   POMINIĘTE — inna wartość w arkuszu");
  }
  console.log(`do zmiany: ${data.length} z ${ids.size}`);
  if (!APPLY) return console.log("(podgląd — uruchom z --apply)");
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { valueInputOption: "USER_ENTERED", data } });
  console.log("ZAPISANO");
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(2); });
