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
  };
}

/** Czy e-mail należy do konta testowego (konta_testowe w Vars_MEMBERS). */
export async function isTestAccount(db: FirebaseFirestore.Firestore, email: string): Promise<boolean> {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return false;
  return (await getAppVars(db)).testAccounts.includes(e);
}
