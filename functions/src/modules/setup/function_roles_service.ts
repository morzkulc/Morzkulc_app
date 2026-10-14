/**
 * Rozwiązywanie e-maila aktualnego operatora "konta funkcyjnego" (prezes/skarbnik/
 * sprzętowiec/szkoleniowiec itd.) — źródło: service_state/function_roles.<key>.email,
 * z fallbackiem na setup/vars_members.vars.<key>.value. Ten sam mechanizm, którym
 * getKlubInfoHandler.ts ustala operatorów funkcji na potrzeby boksu "Klub" w profilu;
 * tu wydzielony jako pojedyncze, tanie zapytanie dla jednej funkcji naraz (np. do bramki
 * uprawnień "opiekun basenowy" w registerUserHandler.ts).
 */

function singleEmail(raw: any): string {
  const s = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!s || s.includes(",") || s.includes(";")) return "";
  if (!s.includes("@") || s.startsWith("@") || s.endsWith("@")) return "";
  return s;
}

export async function resolveFunctionRoleEmail(
  db: FirebaseFirestore.Firestore,
  key: string
): Promise<string> {
  const [stateSnap, varsSnap] = await Promise.all([
    db.collection("service_state").doc("function_roles").get(),
    db.collection("setup").doc("vars_members").get(),
  ]);

  const state = stateSnap.exists ? (stateSnap.data() as any) : null;
  const vars = varsSnap.exists ? (varsSnap.data() as any)?.vars : null;

  const fromState = singleEmail(state?.[key]?.email);
  if (fromState) return fromState;

  return singleEmail(vars?.[key]?.value);
}

// Funkcje zarządu w kolejności prezentacji. mailbox = domyślna skrzynka funkcyjna
// (kontakt zawsze przez nią, nie przez prywatny adres operatora). Może zostać
// nadpisana przez service_state/function_roles.<key>.mailbox.
export const FUNCTION_ROLES: Array<{key: string; label: string; mailbox: string}> = [
  {key: "prezes", label: "Prezes", mailbox: "prezes@morzkulc.pl"},
  {key: "skarbnik", label: "Skarbnik", mailbox: "skarbnik@morzkulc.pl"},
  {key: "sprzetowiec", label: "Sprzętowiec", mailbox: "sprzetowiec@morzkulc.pl"},
  {key: "szkoleniowiec", label: "Szkoleniowiec", mailbox: "szkoleniowiec@morzkulc.pl"},
];

export type ZarzadEntry = {funkcja: string; name: string; mailbox: string};

/** Składa imię+nazwisko z profilu, z fallbackiem na ksywę/displayName. */
export function fullNameFromUser(u: any, fallback: string): string {
  const p = u?.profile || {};
  const full = [p.firstName, p.lastName].map((s) => String(s || "").trim()).filter(Boolean).join(" ").trim();
  return full || String(p.nickname || "").trim() || String(u?.displayName || "").trim() || fallback;
}

/**
 * Zarząd: funkcja → operator (imię i nazwisko) + skrzynka funkcyjna. state/vars to
 * już odczytane service_state/function_roles i setup/vars_members.vars (wołający
 * zwykle i tak ich potrzebuje). Funkcję bez przypisanego operatora pomijamy.
 * Wspólne dla /api/klub (zalogowani) i /api/public/site (wizytówka publiczna).
 */
export async function resolveZarzad(
  db: FirebaseFirestore.Firestore,
  state: any,
  vars: any
): Promise<ZarzadEntry[]> {
  const resolved = FUNCTION_ROLES.map((r) => {
    const fromState = singleEmail(state?.[r.key]?.email);
    const fromVars = singleEmail(vars?.[r.key]?.value);
    const mailbox = String(state?.[r.key]?.mailbox || "").trim() || r.mailbox;
    return {funkcja: r.label, mailbox, email: fromState || fromVars};
  });

  // Nazwy jednym zapytaniem (Firestore "in" ≤ 10 wartości).
  const emails = Array.from(new Set(resolved.map((r) => r.email).filter(Boolean)));
  const nameByEmail = new Map<string, string>();
  if (emails.length) {
    const usersSnap = await db.collection("users_active").where("email", "in", emails.slice(0, 10)).get();
    usersSnap.forEach((d) => {
      const u = d.data() as any;
      const e = String(u?.email || "").trim().toLowerCase();
      if (e) nameByEmail.set(e, fullNameFromUser(u, ""));
    });
  }

  return resolved
    .filter((r) => r.email)
    .map((r) => ({funkcja: r.funkcja, name: nameByEmail.get(r.email) || r.email, mailbox: r.mailbox}));
}
