/**
 * Pre-flight arkusza członków: konflikty adresów e-mail. Wykryty konflikt PRZERYWA sync
 * (zero zapisów) z listą osób do poprawy.
 *
 * Dlaczego bezwzględnie (incydent 30.10.2026): w wierszu jednej osoby wpisano adres innej.
 *  - users.syncFieldsFromSheet dopasowuje konto po ID i nadpisuje e-mail konta adresem
 *    z arkusza — konto dostało cudzy adres (maile, uprawnienia basenu, konta testowe);
 *  - users.syncRolesFromSheet dopasowuje konto po e-mailu — rola z cudzego wiersza
 *    trafiłaby na niewłaściwe konto (i do grup Workspace).
 */

export type SheetMemberRow = {memberId: string; email: string; name: string};
export type AppAccount = {memberId: string | null; email: string; name: string};

const label = (r: SheetMemberRow) => `#${r.memberId || "?"} ${r.name || "(bez nazwy)"}`;

/**
 * Zwraca opisy konfliktów (pusta lista = brak):
 *  1) ten sam e-mail w dwóch wierszach arkusza,
 *  2) e-mail wiersza należy w aplikacji do konta INNEGO członka (inne ID).
 */
export function findMemberEmailConflicts(rows: SheetMemberRow[], accounts: AppAccount[] = []): string[] {
  const out: string[] = [];
  const byEmail = new Map<string, SheetMemberRow[]>();
  for (const r of rows) {
    const email = String(r.email || "").trim().toLowerCase();
    if (!email) continue;
    byEmail.set(email, [...(byEmail.get(email) || []), r]);
  }
  for (const [email, list] of byEmail) {
    if (list.length > 1) out.push(`${email}: ${list.map(label).join(" ↔ ")} (ten sam adres w kilku wierszach)`);
  }

  const accountByEmail = new Map<string, AppAccount>();
  for (const a of accounts) {
    const email = String(a.email || "").trim().toLowerCase();
    if (email) accountByEmail.set(email, a);
  }
  for (const [email, list] of byEmail) {
    if (list.length > 1) continue; // już zgłoszone wyżej
    const acc = accountByEmail.get(email);
    const r = list[0];
    if (acc && acc.memberId && r.memberId && String(acc.memberId) !== String(r.memberId)) {
      out.push(`${email}: wiersz ${label(r)}, a w aplikacji to adres konta #${acc.memberId} ${acc.name || ""}`.trim());
    }
  }
  return out;
}

export function emailConflictMessage(conflicts: string[]): string {
  const MAX_LIST = 20;
  const shown = conflicts.slice(0, MAX_LIST);
  const extra = conflicts.length - shown.length;
  return "Synchronizacja przerwana — konflikt adresów e-mail w arkuszu członków.\n" +
    `Konflikty (${conflicts.length}):\n${shown.map((c) => `• ${c}`).join("\n")}` +
    (extra > 0 ? `\n• …i ${extra} więcej` : "") +
    "\nKażda osoba musi mieć własny, unikalny adres (ten, którym loguje się do aplikacji). Popraw adresy i ponów synchronizację.";
}
