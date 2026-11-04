import * as admin from "firebase-admin";
import {AppVars} from "../setup/app_vars";
import {todayWarsawIso} from "../shared/date_range_utils";
import {normNullish} from "../shared/text_utils";
import {DuesClientError, DuesStatus, computeDuesStatus, formatDatePl, formatPln} from "./dues_service";

/**
 * Prośba o zawieszenie członkostwa wysyłana przez osobę zalegającą ze składkami (Profil → Składki).
 * Aplikacja niczego nie zawiesza sama — wysyła mail do Zarządu (+ potwierdzenie do członka);
 * zawieszenie = status „Zawieszony” w arkuszu członków, wprowadzany przez Zarząd.
 * Jedna prośba na osobę (doc = uid); ponowna dopiero po skladki_dni_ponowna_prosba_zawieszenie dniach.
 */

export const DUES_SUSPENSION_REQUESTS = "dues_suspension_requests";
export const SUSPENSION_MAIL_TO = "zarzad@morzkulc.pl";
export const SUSPENSION_MESSAGE_MAX = 1000;

export interface SuspensionRequest {
  uid: string;
  memberId: number | null;
  userName: string;
  userEmail: string;
  roleKey: string;
  kind: DuesStatus["kind"];
  paidUntil: string;
  overdue: number;
  overduePln: number;
  message: string;
  requestDateIso: string;
  createdAt: any;
}

export interface SuspensionInfo {
  /** Przycisk widoczny (zaległość ≥ skladki_prosba_zawieszenie_od_semestrow, licząc bieżący semestr; konto aktywne; brak świeżej prośby). */
  canRequest: boolean;
  /** Data ostatniej prośby (YYYY-MM-DD), gdy jeszcze „świeża” — wtedy zamiast przycisku informacja. */
  requestedAt: string;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / 86400000);
}

export function suspensionInfo(userData: any, vars: AppVars, lastRequestIso: string, todayIso: string = todayWarsawIso()): SuspensionInfo {
  if (String(userData?.status_key || "status_aktywny") !== "status_aktywny") return {canRequest: false, requestedAt: ""};
  const fresh = Boolean(lastRequestIso) && daysBetween(lastRequestIso, todayIso) < vars.duesSuspensionResendDays;
  if (fresh) return {canRequest: false, requestedAt: lastRequestIso};
  const st = computeDuesStatus(userData, vars, todayIso);
  return {canRequest: st.applicable && (st.overdue ?? 0) >= vars.duesSuspensionMinOverdue, requestedAt: ""};
}

const ROLE_LABEL: Record<string, string> = {
  rola_czlonek: "członek", rola_kandydat: "kandydat", rola_zarzad: "członek Zarządu", rola_kr: "członek Komisji Rewizyjnej",
};

function semLabel(n: number): string {
  return `${n} ${n === 1 ? "semestr" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "semestry" : "semestrów"}`;
}

/** Treść obu maili — wydzielona, żeby dało się ją pokazać/przetestować bez wysyłki. */
export function buildSuspensionMails(r: SuspensionRequest, appUrl: string): {
  board: {to: string; subject: string; body: string};
  member: {to: string; subject: string; body: string};
} {
  const who = `${r.userName}${r.memberId ? ` (ID: ${r.memberId})` : ""}`;
  const debt = `${semLabel(r.overdue)}${r.overduePln > 0 ? ` (${formatPln(r.overduePln)})` : ""}`;
  const board = {
    to: SUSPENSION_MAIL_TO,
    subject: `Prośba o zawieszenie członkostwa — ${who}`,
    body: [
      `${who} prosi o zawieszenie członkostwa w SKK Morzkulc.`,
      "",
      `E-mail: ${r.userEmail}`,
      `Rola: ${ROLE_LABEL[r.roleKey] || r.roleKey}`,
      `${r.kind === "wpisowe" ? "Wpisowe" : "Składki"} opłacone do: ${r.paidUntil ? formatDatePl(r.paidUntil) : "brak wpłat"}`,
      `Zaległość: ${debt}`,
      "",
      "Wiadomość od członka:",
      r.message || "(brak)",
      "",
      `Prośba wysłana z aplikacji (Profil → Składki) ${formatDatePl(r.requestDateIso)}.`,
      "",
      "Co dalej:",
      "- decyzję przekaż członkowi — odpowiedz na jego adres e-mail podany wyżej,",
      "- zawieszenie: w arkuszu członków zmień status na „Zawieszony” — aplikacja zastosuje go przy nocnej synchronizacji.",
      "",
      appUrl,
    ].join("\n"),
  };
  const member = {
    to: r.userEmail,
    subject: "Prośba o zawieszenie członkostwa — przekazana do Zarządu",
    body: [
      "Twoja prośba o zawieszenie członkostwa trafiła do Zarządu SKK Morzkulc.",
      "",
      `${r.kind === "wpisowe" ? "Wpisowe" : "Składki"} opłacone do: ${r.paidUntil ? formatDatePl(r.paidUntil) : "brak wpłat"}`,
      `Zaległość: ${debt}`,
      ...(r.message ? ["", "Twoja wiadomość:", r.message] : []),
      "",
      `Zarząd odpowie mailowo. W razie pytań: ${SUSPENSION_MAIL_TO}.`,
      "",
      appUrl,
      "",
      "SKK Morzkulc",
    ].join("\n"),
  };
  return {board, member};
}

export async function lastSuspensionRequestIso(db: FirebaseFirestore.Firestore, uid: string): Promise<string> {
  const snap = await db.collection(DUES_SUSPENSION_REQUESTS).doc(uid).get();
  return snap.exists ? normNullish((snap.data() as any)?.requestDateIso) : "";
}

export async function createSuspensionRequest(
  db: FirebaseFirestore.Firestore,
  vars: AppVars,
  args: {uid: string; userData: any; userName: string; message: unknown},
  todayIso: string = todayWarsawIso()
): Promise<SuspensionRequest> {
  const message = normNullish(args.message).slice(0, SUSPENSION_MESSAGE_MAX);
  const ref = db.collection(DUES_SUSPENSION_REQUESTS).doc(args.uid);
  const st = computeDuesStatus(args.userData, vars, todayIso);
  let created: SuspensionRequest | null = null;
  await db.runTransaction(async (tx) => {
    const prev = await tx.get(ref);
    const lastIso = prev.exists ? normNullish((prev.data() as any)?.requestDateIso) : "";
    const info = suspensionInfo(args.userData, vars, lastIso, todayIso);
    if (info.requestedAt) throw new DuesClientError(`Prośba została już wysłana ${formatDatePl(info.requestedAt)}.`);
    if (!info.canRequest) throw new DuesClientError("Prośba o zawieszenie jest dostępna tylko przy zaległości w składkach.");
    const now = admin.firestore.FieldValue.serverTimestamp();
    created = {
      uid: args.uid,
      memberId: Number(args.userData?.memberId) || null,
      userName: args.userName,
      userEmail: normNullish(args.userData?.email).toLowerCase(),
      roleKey: String(args.userData?.role_key || ""),
      kind: st.kind,
      paidUntil: st.paidUntil,
      overdue: st.overdue ?? 0,
      overduePln: (st.overdue ?? 0) * st.feePln,
      message,
      requestDateIso: todayIso,
      createdAt: now,
    };
    tx.set(ref, {...created, notifiedAt: null});
    const jobRef = db.collection("service_jobs").doc();
    tx.set(jobRef, {id: jobRef.id, taskId: "dues.notifySuspensionRequest", payload: {uid: args.uid},
      status: "queued", attempts: 0, createdAt: now, updatedAt: now});
  });
  return created as unknown as SuspensionRequest;
}
