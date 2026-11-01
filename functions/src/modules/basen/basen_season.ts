import * as admin from "firebase-admin";
import {BasenEnrollment, BasenSession, BasenSessionFinal, BasenVars, isSessionCancelled, sessionDecisionMs, todayIso} from "./basen_service";
import {Light, round2, seasonOf, sessionLight, sessionMoney} from "./basen_finance";

/**
 * Sezon basenowy w jednym miejscu: status i wynik każdego terminu, wynik netto
 * sezonu i światło dla terminów jeszcze nierozstrzygniętych. Wołane przez
 * basen.decideSessions (decyzja 30 h przed) i GET /api/basen/sessions.
 */

export type SessionOutcome = "planned" | "confirmed" | "held" | "cancelled";

export interface SeasonSessionRow {
  id: string;
  date: string;
  outcome: SessionOutcome;
  cancelReason: "frekwencja" | "admin" | null;
  zapisy: number; // uczestnicy H1+H2 bez instruktorów (oficjalny próg dla członków)
  zapisyH1: number;
  zapisyH2: number;
  sauna: number;
  entries: number; // płatne godziny basenowe (z sauną i spóźnionymi rezygnacjami bez zwrotu)
  valuePln: number;
  costPln: number;
  resultPln: number;
  light: Light | null; // tylko planned — prognoza decyzji
  decisionAtMs: number;
  kurs: boolean; // termin z pulą kursancką — opłacany przez kurs, poza wynikiem sezonu
}

export interface SeasonSummary {
  key: string;
  netPln: number; // wynik netto: odbyte + potwierdzone terminy
  budgetPln: number;
  budgetLeftPln: number; // zapas straty: budżet + wynik netto
  held: number;
  confirmed: number;
  planned: number;
  cancelledLow: number;
  cancelledAdmin: number;
}

/** Termin, którego wynik trzeba liczyć z zapisów: nieodwołany i jeszcze bez `final`. */
function needsEnrollments(s: BasenSession): boolean {
  return !isSessionCancelled(s) && !s.final;
}

/**
 * Zapisy tylko terminów nierozliczonych (nadchodzące + odbyte przed nocną finalizacją).
 * Odbyte mają wynik w `session.final`, odwołane nie potrzebują zapisów — bez tego każde
 * otwarcie modułu czytało wszystkie zapisy sezonu (perf 01.11.2026, W2).
 */
export async function loadSeasonEnrollments(db: FirebaseFirestore.Firestore, sessions: BasenSession[]): Promise<BasenEnrollment[]> {
  const needed = sessions.filter(needsEnrollments);
  if (!needed.length) return [];
  // sessionId = data terminu (createSession) — zakres po sessionId = zakres dat.
  const first = needed[0].id;
  const last = needed[needed.length - 1].id;
  const snap = await db.collection("basen_enrollments")
    .where("sessionId", ">=", first)
    .where("sessionId", "<=", last)
    .get();
  return snap.docs.map((d) => ({id: d.id, ...d.data()} as BasenEnrollment));
}

function activeParticipants(list: BasenEnrollment[], slot: string): number {
  return list.filter((e) => e.slot === slot && e.status === "active" && e.type !== "instructor").length;
}

export function computeSeason(
  sessions: BasenSession[],
  enrollments: BasenEnrollment[],
  vars: BasenVars,
  today: string = todayIso()
): {rows: SeasonSessionRow[]; summary: SeasonSummary} {
  const bySession = new Map<string, BasenEnrollment[]>();
  for (const e of enrollments) {
    const list = bySession.get(e.sessionId) || [];
    list.push(e);
    bySession.set(e.sessionId, list);
  }

  const rows: SeasonSessionRow[] = sessions.map((s) => {
    const list = bySession.get(s.id) || [];
    const cancelled = isSessionCancelled(s);
    const fin = !cancelled ? s.final : undefined;
    const costPln = Number(s.costPln ?? vars.basen_koszt_terminu);
    const money = cancelled ? {entries: 0, valuePln: 0, costPln: 0, resultPln: 0} :
      fin ? {entries: fin.entries, valuePln: fin.valuePln, costPln: fin.costPln, resultPln: fin.resultPln} :
        sessionMoney(list, costPln);
    let outcome: SessionOutcome;
    if (cancelled) outcome = "cancelled";
    else if (s.date < today) outcome = "held";
    else if (s.decision?.status === "confirmed") outcome = "confirmed";
    else outcome = "planned";
    const zapisyH1 = cancelled ? 0 : fin ? fin.zapisyH1 : activeParticipants(list, "H1");
    const zapisyH2 = cancelled ? 0 : fin ? fin.zapisyH2 : activeParticipants(list, "H2");
    return {
      id: s.id,
      date: s.date,
      outcome,
      cancelReason: cancelled ? (s.cancelReason || "admin") : null,
      // Odwołany z braku frekwencji: liczba zapisów z chwili decyzji.
      zapisy: cancelled ? Number(s.decision?.zapisy || 0) : zapisyH1 + zapisyH2,
      zapisyH1,
      zapisyH2,
      sauna: cancelled ? 0 : fin ? fin.sauna : activeParticipants(list, "SAUNA"),
      ...money,
      light: null,
      decisionAtMs: sessionDecisionMs(s, vars.basen_okno_anulowania_h),
      kurs: Object.values(s.slots || {}).some((sl) => sl?.reservedSpots?.restrictedToKursant === true),
    };
  });

  const counted = rows.filter((r) => !r.kurs && (r.outcome === "held" || r.outcome === "confirmed"));
  const netPln = round2(counted.reduce((sum, r) => sum + r.resultPln, 0));
  const fv = {koszt_terminu: vars.basen_koszt_terminu, max_strata_terminu: vars.basen_max_strata_terminu, budzet_sezonu: vars.basen_budzet_sezonu};
  for (const r of rows) {
    if (r.outcome === "planned") r.light = r.kurs ? "green" : sessionLight(r.resultPln, netPln, fv);
  }

  const key = seasonOf(today).key;
  return {
    rows,
    summary: {
      key,
      netPln,
      budgetPln: vars.basen_budzet_sezonu,
      // Ile straty sezon jeszcze zniesie (reguła: wynik sezonu ≥ −budżet); nadwyżka go powiększa.
      budgetLeftPln: round2(vars.basen_budzet_sezonu + netPln),
      held: rows.filter((r) => r.outcome === "held").length,
      confirmed: rows.filter((r) => r.outcome === "confirmed").length,
      planned: rows.filter((r) => r.outcome === "planned").length,
      cancelledLow: rows.filter((r) => r.outcome === "cancelled" && r.cancelReason === "frekwencja").length,
      cancelledAdmin: rows.filter((r) => r.outcome === "cancelled" && r.cancelReason !== "frekwencja").length,
    },
  };
}

/**
 * Zapisuje wynik odbytych terminów (data < dziś, nieodwołane, bez `final`) na dokumencie
 * terminu. Po dacie terminu zapisy się nie zmieniają, więc wynik jest ostateczny.
 * Wołane przez codzienne zadanie basen.grantInstructorRewards. Zwraca liczbę terminów.
 */
export async function finalizePastSessions(db: FirebaseFirestore.Firestore, vars: BasenVars, today: string = todayIso()): Promise<number> {
  const snap = await db.collection("basen_sessions").where("date", "<", today).get();
  const pending = snap.docs
    .map((d) => ({id: d.id, ...d.data()} as BasenSession))
    .filter(needsEnrollments);
  let done = 0;
  for (const s of pending) {
    const eSnap = await db.collection("basen_enrollments").where("sessionId", "==", s.id).get();
    const list = eSnap.docs.map((d) => ({id: d.id, ...d.data()} as BasenEnrollment));
    const money = sessionMoney(list, Number(s.costPln ?? vars.basen_koszt_terminu));
    const final: BasenSessionFinal = {
      zapisyH1: activeParticipants(list, "H1"),
      zapisyH2: activeParticipants(list, "H2"),
      sauna: activeParticipants(list, "SAUNA"),
      ...money,
    };
    await db.collection("basen_sessions").doc(s.id).update({final, updatedAt: admin.firestore.FieldValue.serverTimestamp()});
    done++;
  }
  return done;
}
