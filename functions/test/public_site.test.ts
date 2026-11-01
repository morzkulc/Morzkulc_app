/**
 * GET /api/public/site — publiczne dane wizytówki (bez logowania).
 * Pilnuje whitelisty pól: endpoint jest otwarty dla każdego, więc nic poza
 * imprezami (nazwa/daty/miejsce), zarządem (funkcja/nazwa/skrzynka), adresem
 * i linkami nie może wyciec.
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {handleGetPublicSite} from "../src/api/getPublicSiteHandler";
import {parseHarmonogram, kursDate, buildPublicKurs} from "../src/modules/kurs/kurs_public";

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
      kurs_cena_mlodzi: {value: ""},
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

  it("finanse: konto, składka semestralna i semestry z SETUP; cennik basenu z vars_basen", async () => {
    const db = seed() as any;
    await db.collection("setup").doc("vars_members").set({vars: {"konto_klubowe": {value: "19 1870 1045"}, "bank_klubowy": {value: "Nest Bank"},
      "składka": {value: 75}, "semestr_1 start": {value: "09-01"}, "semestr_2_start": {value: "03-01"}}});
    await db.collection("setup").doc("vars_basen").set({vars: {basen_cena_za_godzine: {value: 35}, basen_cena_karnet_5: {value: "140"}}});
    const {body} = await run(db);
    expect(body.finanse).toEqual({konto: "1918701045", bank: "Nest Bank", skladkaSemestr: 75, semestry: ["09-01", "03-01"]});
    expect(body.basenCennik).toEqual({godzina: 35, karnet5: 140, karnet10: null});
  });

  it("adres + socjale z SETUP; link inny niż http(s) odrzucony", async () => {
    const {body} = await run(seed());
    expect(body.adres).toBe("Do Studzienki 34A");
    expect(body.social).toEqual({facebook: "https://facebook.com/morzkulc", discord: "https://discord.gg/PNK4dQPm2E"});
    expect(body.film).toMatch(/^https:\/\/firebasestorage\.googleapis\.com\/.+Morzkulc_d%C5%82ugi\.mp4/);
  });

  it("CORS: ACAO * niezależnie od originu (odporne na cache CDN); odpowiedź cache'owalna", async () => {
    const ok = await run(seed());
    expect(ok.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(ok.headers["Vary"]).toBeUndefined();
    expect(ok.headers["Cache-Control"]).toBe("public, max-age=900");
    const other = await run(seed(), "GET", "https://kurs.morzkulc.pl");
    expect(other.headers["Access-Control-Allow-Origin"]).toBe("*");
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
      start: "2027-03-04",
      harmonogram: [
        {from: "2027-03-04", to: "", type: "spotkanie", name: "Spotkanie organizacyjne", place: ""},
        {from: "2027-04-24", to: "2027-04-25", type: "wyjazd", name: "Wyjazd I", place: "Ostrzyce"},
      ],
    });
  });
});

describe("kurs_public start + zniżka wiekowa", () => {
  const h = {harmonogram_01: {value: "2027-03-04 | spotkanie | Spotkanie"}};
  it("kurs_start ma pierwszeństwo przed harmonogramem", () => {
    expect(buildPublicKurs({...h, kurs_start: {value: "01.04.2027"}}).start).toBe("2027-04-01");
    expect(buildPublicKurs(h).start).toBe("2027-03-04");
  });
  it("cena dla młodych tylko w parze z wiekiem", () => {
    const both = buildPublicKurs({kurs_cena_mlodzi: {value: "2200"}, kurs_mlodzi_wiek: {value: "26"}});
    expect([both.cenaMlodzi, both.mlodziWiek]).toEqual([2200, 26]);
    const one = buildPublicKurs({kurs_cena_mlodzi: {value: "2200"}});
    expect(one.cenaMlodzi).toBeUndefined();
    expect(one.mlodziWiek).toBeUndefined();
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

describe("publicSite — dane na żywo dla strony klubu", () => {
  function liveSeed(basenMode: string, basenRoles: string[] = ["rola_czlonek"], basenEnabled = true) {
    const db = seed() as any;
    const add = (col: string, docs: any[]) => docs.forEach((d) => db.collection(col).doc(d._docId).set(d));
    add("users_active", [
      {_docId: "c1", role_key: "rola_czlonek", status_key: "status_aktywny"},
      {_docId: "c2", role_key: "rola_kandydat", status_key: "status_aktywny"},
      {_docId: "c3", role_key: "rola_czlonek", status_key: "status_zawieszony"},
      {_docId: "s1", role_key: "rola_sympatyk", status_key: "status_aktywny"},
    ]);
    add("gear_kayaks", [
      {_docId: "k1", type: "river runner / creek", isActive: true},
      {_docId: "k2", type: "zwałki / niziny", isActive: true},
      {_docId: "k3", type: "morski", isActive: true},
      {_docId: "k4", type: "playboat", isPrivate: true},
      {_docId: "k5", type: "kanada", gearScrapped: true},
    ]);
    add("blachy", [
      {_docId: "b1", imie: "Jan", nazwisko: "Nowak", ksywa: "Nowy", rok: 1990, nr: 1, email: "jan@gmail.com", uzasadnienie: "tajne uzasadnienie", zrodlo: "archiwum_2025", poz: 1},
    ]);
    add("setup", [{_docId: "app", modules: {modul_6: {enabled: basenEnabled, access: {mode: basenMode, rolesAllowed: basenRoles}}}}]);
    add("basen_sessions", [
      {_docId: "2099-01-02", date: "2099-01-02", slots: {H1: {status: "open"}}},
      {_docId: "2099-01-05", date: "2099-01-05", slots: {H1: {status: "cancelled"}}},
      {_docId: "2000-01-01", date: "2000-01-01", slots: {H1: {status: "open"}}},
    ]);
    add("km_map_cache", [{_docId: "v1", locations: [
      {placeName: "Wda", logCount: 5, yearsActive: [2020, 2024], topUsers: [{name: "X"}]},
      {placeName: "Radunia", logCount: 9, yearsActive: [2010, 2025]},
    ]}]);
    return db;
  }

  it("stats: aktywni członkowie z kandydatami, kajaki klubowe według typu (bez prywatnych i złomowanych)", async () => {
    const {body} = await run(liveSeed("prod"));
    expect(body.stats.czlonkowie).toBe(2);
    expect(body.stats.kajaki).toEqual({gorskie: 1, freestyle: 0, nizinne: 1, morskie: 1, kanadyjki: 0, razem: 3});
  });

  it("blachy: rejestr bez e-maili i uzasadnień", async () => {
    const {body} = await run(liveSeed("prod"));
    expect(body.blachy).toEqual([{imie: "Jan", ksywa: "Nowy", nazwisko: "Nowak", rok: 1990, nr: 1, honorowa: false, sp: false, klub: "", okazja: "", miejsce: ""}]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("jan@gmail.com");
    expect(raw).not.toContain("tajne");
  });

  it("basen: terminy (bez odwołanych i minionych), gdy członek widzi moduł w aplikacji (reguła canSeeModule)", async () => {
    expect((await run(liveSeed("prod"))).body.basen).toEqual({ruszyl: true, terminy: ["2099-01-02"]});
    expect((await run(liveSeed("test"))).body.basen.ruszyl).toBe(true);
    expect((await run(liveSeed("test", ["rola_czlonek"], false))).body.basen.ruszyl).toBe(true);
    expect((await run(liveSeed("test", ["rola_zarzad"]))).body.basen).toEqual({ruszyl: false, terminy: []});
    expect((await run(liveSeed("off"))).body.basen.ruszyl).toBe(false);
    expect((await run(liveSeed("prod", ["rola_czlonek"], false))).body.basen.ruszyl).toBe(false);
  });

  it("miejsca: akweny według liczby wpisów, bez osób", async () => {
    const {body} = await run(liveSeed("prod"));
    expect(body.miejsca).toEqual([{nazwa: "Radunia", od: 2010, do: 2025}, {nazwa: "Wda", od: 2020, do: 2024}]);
  });
});
