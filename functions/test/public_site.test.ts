/**
 * GET /api/public/site — publiczne dane wizytówki (bez logowania).
 * Pilnuje whitelisty pól: endpoint jest otwarty dla każdego, więc nic poza
 * imprezami (nazwa/daty/miejsce), zarządem (funkcja/nazwa/skrzynka), adresem
 * i linkami nie może wyciec.
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {handleGetPublicSite} from "../src/api/getPublicSiteHandler";
import {parseHarmonogram, kursDate} from "../src/modules/kurs/kurs_public";

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
    }}, {_docId: "vars_kurs", vars: {
      cena_kursu: {value: 2300},
      kurs_edycja: {value: 2027},
      kurs_zadatek: {value: "950"},
      kurs_cena_student: {value: ""},
      kurs_zapisy_status: {value: "Otwarte"},
      kurs_zapisy_do: {value: "28.02.2027"},
      kurs_link_zapisu: {value: "javascript:alert(1)"},
      kurs_kontakt_email: {value: "szkoleniowiec@morzkulc.pl"},
      koniec_kursu: {value: "30.09"},
      kabina_punkty: {value: 1},
      harmonogram_02: {value: "2027-04-24/2027-04-25 | wyjazd | Wyjazd I | Ostrzyce"},
      harmonogram_01: {value: "2027-03-04 | spotkanie | Spotkanie organizacyjne"},
      harmonogram_03: {value: "zła linia"},
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

  it("kurs: tylko pola z whitelisty, normalizacja, puste i niepoprawne pominięte, harmonogram posortowany", async () => {
    const {body} = await run(seed());
    expect(body.kurs).toEqual({
      edycja: "2027",
      cena: 2300,
      zadatek: 950,
      zapisyStatus: "otwarte",
      zapisyDo: "2027-02-28",
      kontaktEmail: "szkoleniowiec@morzkulc.pl",
      harmonogram: [
        {from: "2027-03-04", to: "", type: "spotkanie", name: "Spotkanie organizacyjne", place: ""},
        {from: "2027-04-24", to: "2027-04-25", type: "wyjazd", name: "Wyjazd I", place: "Ostrzyce"},
      ],
    });
  });

  it("CORS: strona kursu dostaje ACAO", async () => {
    const r = await run(seed(), "GET", "https://kurs.morzkulc.pl");
    expect(r.headers["Access-Control-Allow-Origin"]).toBe("https://kurs.morzkulc.pl");
  });
});

describe("kurs_public parsery", () => {
  it("kursDate: ISO i dd.mm.rrrr, reszta pusta", () => {
    expect(kursDate("2027-03-01")).toBe("2027-03-01");
    expect(kursDate("1.3.2027")).toBe("2027-03-01");
    expect(kursDate("30.09")).toBe("");
  });
  it("parseHarmonogram: odrzuca nieznany typ, złą datę i brak nazwy", () => {
    expect(parseHarmonogram("2027-04-06 | basen | Basen 1 | Żabi Kruk")).toEqual({from: "2027-04-06", to: "", type: "basen", name: "Basen 1", place: "Żabi Kruk"});
    expect(parseHarmonogram("2027-04-06 | impreza | X")).toBeNull();
    expect(parseHarmonogram("2027-04-06/zle | wyjazd | X")).toBeNull();
    expect(parseHarmonogram("2027-04-06 | wyjazd | ")).toBeNull();
  });
});
