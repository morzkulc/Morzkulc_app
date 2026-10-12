import {normNullish} from "../shared/text_utils";
import {fullName, nickname, isRegistered} from "../shared/user_display";

export type MemberActivityRow = {
  rank: number;
  userUid: string;
  userName: string;
  userNick: string;
  userEmail: string;
  hours: number;
};

/**
 * Ranking „Najbardziej aktywni": suma zatwierdzonych godzinek wypracowanych (earn)
 * z grantedAt w [fromIso, toIso], tylko dla zarejestrowanych użytkowników.
 * Wspólne dla raportu zarządu (dowolny zakres) i widoku członka w module Godzinki (semestr).
 *
 * Bilans otwarcia ma grantedAt = 01.04.2026 (OPENING_BALANCE_DATE), więc wchodzi tylko
 * do zakresów obejmujących tę datę.
 */
export async function computeMemberActivity(
  db: FirebaseFirestore.Firestore,
  fromIso: string,
  toIso: string
): Promise<MemberActivityRow[]> {
  // Tylko rekordy "earn" mają grantedAt (północ UTC dnia pracy), więc zapytanie po
  // grantedAt w zakresie zwraca same earny — bez indeksu złożonego.
  const fromDate = new Date(fromIso + "T00:00:00.000Z");
  const toDate = new Date(toIso + "T23:59:59.999Z");

  const snap = await db
    .collection("godzinki_ledger")
    .where("grantedAt", ">=", fromDate)
    .where("grantedAt", "<=", toDate)
    .orderBy("grantedAt")
    .limit(20000)
    .get();

  // „Tylko zarejestrowani" załatwia filtr isRegistered niżej — historyczne konta
  // spoza users_active (np. pule pod hist_*) i tak nie przejdą.
  const hoursByUid = new Map<string, number>();
  snap.forEach((doc) => {
    const r = doc.data() as any;
    if (normNullish(r.type) !== "earn") return;
    if (r.approved !== true) return;
    const ruid = normNullish(r.uid);
    if (!ruid) return;
    hoursByUid.set(ruid, (hoursByUid.get(ruid) || 0) + Number(r.amount || 0));
  });

  const uidList = Array.from(hoursByUid.keys());
  const nameByUid = new Map<string, string>();
  const nickByUid = new Map<string, string>();
  const emailByUid = new Map<string, string>();
  const registered = new Set<string>();
  if (uidList.length) {
    const refs = uidList.map((u) => db.collection("users_active").doc(u));
    const userDocs = await db.getAll(...refs);
    userDocs.forEach((d) => {
      // Tylko zarejestrowani (ukończona rejestracja) — odsiewamy puste konta SSO.
      if (d.exists && isRegistered(d.data())) {
        const u = d.data();
        registered.add(d.id);
        nameByUid.set(d.id, fullName(u));
        nickByUid.set(d.id, nickname(u));
        emailByUid.set(d.id, normNullish((u as any)?.email));
      }
    });
  }

  return uidList
    .filter((u) => registered.has(u))
    .map((u) => ({
      userUid: u,
      userName: nameByUid.get(u) || "",
      userNick: nickByUid.get(u) || "",
      userEmail: emailByUid.get(u) || "",
      hours: Math.round((hoursByUid.get(u) || 0) * 100) / 100,
    }))
    .sort((a, b) => (b.hours - a.hours) || a.userName.localeCompare(b.userName, "pl"))
    .map((row, i) => ({rank: i + 1, ...row}));
}
