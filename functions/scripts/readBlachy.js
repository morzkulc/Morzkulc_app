// READ-ONLY: zbiera osoby z blachą z bilansu otwarcia (arkusz „4_Bilans Otwarcia 2026”,
// zakładka „bilans otwarcia 26”), z arkusza członków („członkowie i sympatycy”, kolumna „blacha”)
// oraz z Firestore (users_opening_balance_26.blacha, users_active.admin.badge).
// Wynik: JSON na stdout. Nic nie zapisuje.
// node --use-system-ca functions/scripts/readBlachy.js > blachy.json
const admin = require("firebase-admin");
const { google } = require("googleapis");

const BO_SHEET_ID = "1dJpaV3OdFHo1ugD_NzSaysXbQyp_HkQe2EVpCiBVDac";
const BO_TAB = "bilans otwarcia 26";
const MEMBERS_SHEET_ID = "1lF5eDF9B6ip4G497qG1QGePXqrXdLPS8kt-3pX-ZBsM";
const MEMBERS_TAB = "członkowie i sympatycy";

async function signJwtWithIamCredentials(serviceAccountEmail, payload) {
  const auth = await google.auth.getClient({ scopes: ["https://www.googleapis.com/auth/iam"] });
  const iam = google.iamcredentials({ version: "v1", auth });
  const res = await iam.projects.serviceAccounts.signJwt({
    name: "projects/-/serviceAccounts/" + serviceAccountEmail,
    requestBody: { payload: JSON.stringify(payload) },
  });
  return res.data.signedJwt;
}
async function exchangeJwtForAccessToken(assertion) {
  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.set("assertion", assertion);
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body,
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error("token exchange failed: " + resp.status + " " + text);
  return JSON.parse(text).access_token;
}
async function getDelegatedSheetsClient() {
  const sa = "workspace-bot@morzkulc-e9df7.iam.gserviceaccount.com";
  const sub = "admin@morzkulc.pl";
  const scopes = ["https://www.googleapis.com/auth/spreadsheets"];
  const iat = Math.floor(Date.now() / 1000);
  const jwtPayload = { iss: sa, sub, scope: scopes.join(" "), aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 };
  const signedJwt = await signJwtWithIamCredentials(sa, jwtPayload);
  const accessToken = await exchangeJwtForAccessToken(signedJwt);
  const oauth2 = new google.auth.OAuth2();
  oauth2.setCredentials({ access_token: accessToken });
  return google.sheets({ version: "v4", auth: oauth2 });
}

const norm = (h) => String(h || "").trim().toLowerCase();

async function readTab(sheets, id, tab) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: id, range: `'${tab}'` });
  const [head, ...rows] = r.data.values || [];
  return rows.map((row, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { o[String(h).trim()] = row[j] == null ? "" : String(row[j]).trim(); });
    return o;
  });
}

function pick(o, name) {
  const k = Object.keys(o).find((x) => norm(x) === norm(name));
  return k ? o[k] : "";
}

const isBadge = (v) => {
  const s = norm(v);
  return s !== "" && s !== "false" && s !== "nie" && s !== "0";
};

(async () => {
  const sheets = await getDelegatedSheetsClient();
  const bo = await readTab(sheets, BO_SHEET_ID, BO_TAB);
  const mem = await readTab(sheets, MEMBERS_SHEET_ID, MEMBERS_TAB);

  admin.initializeApp({ projectId: "morzkulc-e9df7" });
  const db = admin.firestore();
  const [obSnap, uaSnap] = await Promise.all([
    db.collection("users_opening_balance_26").get(),
    db.collection("users_active").get(),
  ]);

  const out = {
    bo: bo.filter((r) => isBadge(pick(r, "blacha"))).map((r) => ({
      row: r._row, id: pick(r, "ID"), nrLeg: pick(r, "Nr leg."), imie: pick(r, "Imię"), nazwisko: pick(r, "Nazwisko"),
      ksywa: pick(r, "Ksywa"), email: pick(r, "e-mail"), blacha: pick(r, "blacha"), rzeczywisty: pick(r, "rzeczywisty"),
      szkoleniowka: pick(r, "Szkoleniówka"), funkcje: pick(r, "Funkcje pełnione na rzecz klubu"),
    })),
    boBlachaValues: [...new Set(bo.map((r) => pick(r, "blacha")))],
    boRows: bo.length,
    members: mem.filter((r) => isBadge(pick(r, "blacha"))).map((r) => ({
      row: r._row, id: pick(r, "ID"), imie: pick(r, "imię"), nazwisko: pick(r, "nazwisko"), ksywa: pick(r, "ksywa"),
      email: pick(r, "e-mail"), blacha: pick(r, "blacha"), rola: pick(r, "Rola"), status: pick(r, "Status"),
    })),
    membersBlachaValues: [...new Set(mem.map((r) => pick(r, "blacha")))],
    membersRows: mem.length,
    firestoreOb: obSnap.docs.filter((d) => isBadge(d.data().blacha)).map((d) => ({ id: d.id, blacha: d.data().blacha })),
    firestoreUsers: uaSnap.docs.filter((d) => isBadge(d.data()?.admin?.badge)).map((d) => ({
      uid: d.id, email: d.data().email, badge: d.data().admin.badge, memberId: d.data().memberId ?? null,
    })),
  };
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
