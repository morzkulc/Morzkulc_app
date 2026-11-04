import {getCachedDoc} from "./doc_cache";
export type AppVarsDoc = {
  vars?: Record<string, { value?: any }>;
};

export type AppVars = {
  /** Link do aplikacji pokazywany w mailach (setup/vars_members.link_aplikacji) */
  appUrl: string;
  /** Adresat digestu zaległych zatwierdzeń (setup/vars_members.admin_notify_email) */
  adminNotifyEmail: string;
  /** Próg wieku (dni) digestu zaległych zatwierdzeń (setup/vars_members.admin_notify_dni_progu) */
  adminNotifyAgeDays: number;
  /** Adresat maili AKCJA dla admina — app password itp. (setup/vars_members.admin_action_email) */
  adminActionEmail: string;
  /**
   * Konta testowe (setup/vars_members.konta_testowe, lista po przecinku) — tester przełącza
   * sobie rolę w aplikacji; konta nigdy nie trafiają do grup Workspace ani do arkusza członków.
   */
  testAccounts: string[];
  /** Konto klubowe do przelewów (setup/vars_members.konto_klubowe / bank_klubowy) */
  clubAccount: string;
  clubBank: string;
  /** Końce semestrów „mm-dd” (setup/vars_members.semestr_1_stop / semestr_2_stop) — jedyne dopuszczalne daty „Składki”. */
  semesterEnds: string[];
  /** Składka za semestr w zł (setup/vars_members.składka); 0 = brak w SETUP. Wpisowe = 2 × składka. */
  duesFeePln: number;
  /** Zaległość (w semestrach) powyżej której wpłata tylko po kontakcie z Zarządem (skladki_max_zaleglosc_semestrow). */
  duesMaxOverdueSemesters: number;
  /** Pop-up przypomnienia przy otwarciu aplikacji, gdy zaległość > N semestrów (skladki_popup_zaleglosc_semestrow). */
  duesPopupOverdueSemesters: number;
  /** Ile dni decyzja widnieje w Zarząd → Składki → „Ostatnie decyzje” (skladki_dni_ostatnie_decyzje). */
  duesRecentDecisionsDays: number;
  /** Po ilu dniach można ponownie wysłać prośbę o zawieszenie członkostwa (skladki_dni_ponowna_prosba_zawieszenie). */
  duesSuspensionResendDays: number;
  /** Przycisk „Poproś o zawieszenie” od zaległości N semestrów, licząc bieżący (skladki_prosba_zawieszenie_od_semestrow). */
  duesSuspensionMinOverdue: number;
  /** Odwieszenie członkostwa: ile semestrów (razem z bieżącym) płaci zawieszony zamiast całej zaległości (skladki_odwieszenie_semestrow). */
  duesReinstateSemesters: number;
  /** Po ilu dniach niezatwierdzonego zgłoszenia mail do skarbnika (skladki_dni_alert_skarbnik). */
  duesTreasurerAlertDays: number;
  /** Ile dni przed końcem opłaconego okresu przypomnienie dla chętnych (skladki_dni_przypomnienia). */
  duesReminderDays: number;
};

function getVar(doc: AppVarsDoc | null, key: string): any {
  return doc?.vars?.[key]?.value;
}

function toStr(v: any, fallback: string): string {
  const s = String(v ?? "").trim();
  return s || fallback;
}

function toNumber(v: any, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function getAppVars(db: FirebaseFirestore.Firestore): Promise<AppVars> {
  const snap = await getCachedDoc(db, "setup", "vars_members");
  const raw = (snap.exists ? (snap.data() as AppVarsDoc) : null) || null;

  return {
    appUrl: toStr(getVar(raw, "link_aplikacji"), "https://app.morzkulc.pl/"),
    adminNotifyEmail: toStr(getVar(raw, "admin_notify_email"), "zarzad@morzkulc.pl"),
    adminNotifyAgeDays: toNumber(getVar(raw, "admin_notify_dni_progu"), 3),
    adminActionEmail: toStr(getVar(raw, "admin_action_email"), "zarzad@morzkulc.pl"),
    testAccounts: String(getVar(raw, "konta_testowe") ?? "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean),
    clubAccount: toStr(getVar(raw, "konto_klubowe"), ""),
    clubBank: toStr(getVar(raw, "bank_klubowy"), ""),
    semesterEnds: ["semestr_1_stop", "semestr_2_stop"]
      .map((k) => String(getVar(raw, k) ?? "").trim())
      .filter((v) => /^\d{2}-\d{2}$/.test(v)),
    duesFeePln: toNumber(getVar(raw, "składka"), 0),
    duesMaxOverdueSemesters: toNumber(getVar(raw, "skladki_max_zaleglosc_semestrow"), 8),
    duesPopupOverdueSemesters: toNumber(getVar(raw, "skladki_popup_zaleglosc_semestrow"), 2),
    duesRecentDecisionsDays: toNumber(getVar(raw, "skladki_dni_ostatnie_decyzje"), 30),
    duesSuspensionResendDays: toNumber(getVar(raw, "skladki_dni_ponowna_prosba_zawieszenie"), 30),
    duesSuspensionMinOverdue: toNumber(getVar(raw, "skladki_prosba_zawieszenie_od_semestrow"), 4),
    duesReinstateSemesters: toNumber(getVar(raw, "skladki_odwieszenie_semestrow"), 2),
    duesTreasurerAlertDays: toNumber(getVar(raw, "skladki_dni_alert_skarbnik"), 3),
    duesReminderDays: toNumber(getVar(raw, "skladki_dni_przypomnienia"), 14),
  };
}

/** Czy e-mail należy do konta testowego (konta_testowe w Vars_MEMBERS). */
export async function isTestAccount(db: FirebaseFirestore.Firestore, email: string): Promise<boolean> {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;
  return (await getAppVars(db)).testAccounts.includes(e);
}
