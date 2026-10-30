/**
 * Konflikty e-maili w arkuszu członków (incydent 30.10.2026) — sync ma się przerwać.
 */
import {describe, it, expect} from "vitest";
import {findMemberEmailConflicts, emailConflictMessage} from "../src/modules/users/member_email_conflicts";

describe("findMemberEmailConflicts", () => {
  it("ten sam e-mail w dwóch wierszach (bez względu na wielkość liter)", () => {
    const c = findMemberEmailConflicts([
      {memberId: "94", email: "weronika@x.pl", name: "Weronika L"},
      {memberId: "120", email: "Weronika@X.pl ", name: "Michał J"},
      {memberId: "121", email: "", name: "Bez maila"},
    ]);
    expect(c).toHaveLength(1);
    expect(c[0]).toContain("#94 Weronika L ↔ #120 Michał J");
  });

  it("adres wiersza należy w aplikacji do konta innego członka", () => {
    const c = findMemberEmailConflicts(
      [{memberId: "120", email: "weronika@x.pl", name: "Michał J"}],
      [{memberId: "94", email: "weronika@x.pl", name: "Weronika L"}, {memberId: "120", email: "michal@x.pl", name: "Michał J"}],
    );
    expect(c).toEqual(["weronika@x.pl: wiersz #120 Michał J, a w aplikacji to adres konta #94 Weronika L"]);
    expect(emailConflictMessage(c)).toMatch(/Synchronizacja przerwana/);
  });

  it("poprawne dane → brak konfliktów (także własny adres konta i konto bez memberId)", () => {
    expect(findMemberEmailConflicts(
      [{memberId: "94", email: "weronika@x.pl", name: "W"}, {memberId: "120", email: "michal@x.pl", name: "M"}],
      [{memberId: "94", email: "weronika@x.pl", name: "W"}, {memberId: null, email: "michal@x.pl", name: "M"}],
    )).toEqual([]);
  });
});
