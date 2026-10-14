/**
 * GET /api/public/site — publiczne dane wizytówki (bez logowania).
 * Pilnuje whitelisty pól: endpoint jest otwarty dla każdego, więc nic poza
 * imprezami (nazwa/daty/miejsce), zarządem (funkcja/nazwa/skrzynka), adresem
 * i linkami nie może wyciec.
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {handleGetPublicSite} from "../src/api/getPublicSiteHandler";

function seed() {
  return new FakeFirestore({
    events: [
      {id: "e1", name: "Spływ Drawą", startDate: "2099-05-01", endDate: "2099-05-03", location: "Drawa",
        description: "opis", contact: "600 100 200", approved: true, kierownicy: [{email: "k@x.pl", uid: "k", displayName: "K"}]},
      {id: "e2", name: "Niezatwierdzona", startDate: "2099-06-01", endDate: "2099-06-01", location: "X", approved: false},
      {id: "e3", name: "Stara", startDate: "2000-01-01", endDate: "2000-01-02", location: "Y", approved: true},
    ],
    service_state: [{_docId: "function_roles", prezes: {email: "anna@gmail.com"}}],
    setup: [{_docId: "vars_members", vars: {
      szkoleniowiec: {value: "bob@gmail.com"},
      adres_klub: {value: "Do Studzienki 34A"},
      facebook_url: {value: "https://facebook.com/morzkulc"},
      instagram_url: {value: "javascript:alert(1)"},
      stan_konta: {value: "1000"},
    }}],
    users_active: [
      {_docId: "anna", email: "anna@gmail.com", profile: {firstName: "Anna", lastName: "Nowak", phone: "500"}},
      {_docId: "bob", email: "bob@gmail.com", profile: {firstName: "Bob", lastName: "Kowal", phone: "501"}},
    ],
  });
}

async function run(db: FakeFirestore, method = "GET", origin = "http://www.morzkulc.pg.gda.pl") {
  const out: {status: number; body: any; headers: Record<string, string>} = {status: 0, body: null, headers: {}};
  const res: any = {
    setHeader(k: string, v: string) {
      out.headers[k] = v;
    },
    status(s: number) {
      out.status = s;
      return res;
    },
    json(b: any) {
      out.body = b;
      return res;
    },
    send(b: any) {
      out.body = b;
      return res;
    },
  };
  await handleGetPublicSite({method, headers: {origin}} as any, res, {
    db: db as any,
    requireAllowedHost: () => true,
    setCorsHeaders: () => undefined,
  });
  return out;
}

describe("publicSite", () => {
  it("zwraca tylko zatwierdzone nadchodzące imprezy i tylko pola publiczne", async () => {
    const {status, body} = await run(seed());
    expect(status).toBe(200);
    expect(body.events).toEqual([{name: "Spływ Drawą", startDate: "2099-05-01", endDate: "2099-05-03", location: "Drawa"}]);
  });

  it("zarząd: funkcja + imię i nazwisko + skrzynka funkcyjna, bez prywatnych e-maili i telefonów", async () => {
    const {body} = await run(seed());
    expect(body.zarzad).toEqual([
      {funkcja: "Prezes", name: "Anna Nowak", mailbox: "prezes@morzkulc.pl"},
      {funkcja: "Szkoleniowiec", name: "Bob Kowal", mailbox: "szkoleniowiec@morzkulc.pl"},
    ]);
    const raw = JSON.stringify(body);
    for (const leak of ["gmail.com", "500", "501", "600 100 200", "1000", "opis", "k@x.pl"]) {
      expect(raw).not.toContain(leak);
    }
  });

  it("adres + socjale z SETUP; link inny niż http(s) odrzucony", async () => {
    const {body} = await run(seed());
    expect(body.adres).toBe("Do Studzienki 34A");
    expect(body.social).toEqual({facebook: "https://facebook.com/morzkulc"});
  });

  it("CORS: origin wizytówki dostaje ACAO, obcy nie; odpowiedź cache'owalna", async () => {
    const ok = await run(seed());
    expect(ok.headers["Access-Control-Allow-Origin"]).toBe("http://www.morzkulc.pg.gda.pl");
    expect(ok.headers["Cache-Control"]).toBe("public, max-age=900");
    const evil = await run(seed(), "GET", "https://evil.example");
    expect(evil.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("OPTIONS → 204, POST → 405", async () => {
    expect((await run(seed(), "OPTIONS")).status).toBe(204);
    expect((await run(seed(), "POST")).status).toBe(405);
  });
});
