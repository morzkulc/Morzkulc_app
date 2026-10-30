/**
 * Wsteczna korekta bonusu miesięcznego za funkcję dla KR (decyzja 30.10.2026):
 * KR dostawał 10 h (bonus_miesieczny_zarzad), ma dostawać bonus_miesieczny_kr (2 h).
 *
 * Dla każdego wpisu „Bonus miesięczny za pełnioną funkcję" osoby z KR dopisuje operację
 * „spend" o różnicę (np. −8 h) zwykłym odjęciem godzinek (deductHours, FIFO, force) — historia
 * pokazuje +10 i korektę −8, saldo jest poprawne także gdy bonus był już wydany.
 * Wpis bonusu dostaje znacznik krCorrection (ponowne uruchomienie go pomija).
 *
 * KR rozpoznawany po bonusRole (nowe wpisy) albo — dla starszych — po bieżącej roli.
 * Podgląd wypisuje WSZYSTKICH odbiorców bonusu z bieżącą rolą do weryfikacji.
 *
 * Uruchomienie (z functions/, po npm run build):
 *   node --use-system-ca scripts/fixKrMonthlyBonus.js           — podgląd
 *   node --use-system-ca scripts/fixKrMonthlyBonus.js --apply   — zapis
 */
const admin = require("firebase-admin");

const APPLY = process.argv.includes("--apply");
admin.initializeApp({projectId: "morzkulc-e9df7"});
const db = admin.firestore();
const {deductHours} = require("../lib/modules/hours/godzinki_service.js");
const {getGodzinkiVars} = require("../lib/modules/hours/godzinki_vars.js");
const {BOARD_BONUS_REASON} = require("../lib/service/tasks/godzinkiMonthlyBalanceReview.js");

(async () => {
  const vars = await getGodzinkiVars(db);
  const target = vars.krMonthlyBonusHours;
  const snap = await db.collection("godzinki_ledger").where("reason", "==", BOARD_BONUS_REASON).get();
  const users = new Map();
  const userOf = async (uid) => {
    if (!users.has(uid)) {
      const u = (await db.collection("users_active").doc(uid).get()).data() || {};
      const name = [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(" ") || u.email || uid;
      users.set(uid, {role: u.role_key || "?", name});
    }
    return users.get(uid);
  };

  console.log(`Bonus KR docelowo: ${target} h. Wpisów bonusu: ${snap.size}`);
  let todo = 0;
  let totalDeduct = 0;
  const rows = [];
  for (const d of snap.docs) {
    const r = d.data();
    const u = await userOf(r.uid);
    const month = r.grantedAt?.toDate ? r.grantedAt.toDate().toISOString().slice(0, 7) : "?";
    const isKr = r.bonusRole ? r.bonusRole === "rola_kr" : u.role === "rola_kr";
    const delta = Number(r.amount) - target;
    const status = r.krCorrection ? "już skorygowany" : !isKr ? "zarząd — bez zmian" : delta > 0 ? `korekta −${delta} h` : "bez zmian";
    rows.push(`${month}  ${u.name.padEnd(28)} ${u.role.padEnd(13)} +${r.amount} h  → ${status}`);
    if (!isKr || r.krCorrection || delta <= 0) continue;
    todo++;
    totalDeduct += delta;
    if (!APPLY) continue;
    const res = await deductHours(db, r.uid, {
      amount: delta,
      reason: `Korekta bonusu za funkcję KR (${r.amount} → ${target} h), ${month}`,
      force: true,
    }, vars);
    if (!res.ok) throw new Error(`${d.id}: ${res.code} ${res.message}`);
    await d.ref.update({krCorrection: {deducted: delta, target, at: admin.firestore.FieldValue.serverTimestamp()}});
  }
  rows.sort().forEach((l) => console.log(l));
  console.log(`${APPLY ? "Skorygowano" : "Do korekty"}: ${todo} wpisów, razem −${totalDeduct} h`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
