/**
 * Procedura nadawania Blach: konfiguracja z SETUP, nominacje (§3), Kapituła z tajnym głosowaniem (§5),
 * Zarząd (zatwierdzenie/zwrot), potwierdzenie przyjęcia, ogłoszenie i zadanie dzienne.
 */
import {describe, it, expect} from "vitest";
import {FakeFirestore} from "./helpers/fake_firestore";
import {
  parseBlachyConfig, faza, seatVoters, candidateKey, validateNominacja, nextNumer, canEditRegistry,
} from "../src/modules/blachy/blachy_procedura";
import {handleBlachyApi} from "../src/api/blachyApiHandler";
import {blachyAnnounceTask, blachyDailyTask, blachyRequestAcceptanceTask} from "../src/service/tasks/blachyProcedura";

const K = ["k1@x.pl", "k2@x.pl", "k3@x.pl", "k4@x.pl", "k5@x.pl"];
const Z = ["z1@x.pl", "z2@x.pl", "z3@x.pl", "z4@x.pl", "z5@x.pl"];

function vars(over: Record<string, string> = {}) {
  const v: Record<string, {value: string}> = {
    blachy_procedura: {value: "TRUE"},
    blachy_nominacje_od: {value: "01.09"},
    blachy_nominacje_do: {value: "30.09"},
    blachy_kapitula_przewodniczacy: {value: K[0]},
    link_aplikacji: {value: "https://app.morzkulc.pl/"},
  };
  K.forEach((e, i) => (v[`blachy_kapitula_${i + 1}`] = {value: e}));
  Z.forEach((e, i) => (v[`blachy_kapitula_zastepca_${i + 1}`] = {value: e}));
  for (const [k, val] of Object.entries(over)) v[k] = {value: val};
  return v;
}

function user(uid: string, email: string, role = "rola_czlonek", first = uid, last = "Nowak") {
  return {_docId: uid, email, role_key: role, status_key: "status_aktywny", profile: {firstName: first, lastName: last}};
}

function seed(extra: Record<string, any[]> = {}, v = vars()) {
  const users = [
    user("ala", "ala@x.pl"), user("bob", "bob@x.pl", "rola_czlonek", "Bob", "Kowal"), user("sym", "sym@x.pl", "rola_sympatyk"),
    user("zar", "zar@x.pl", "rola_zarzad"),
    ...K.map((e, i) => user(`k${i + 1}`, e, "rola_czlonek", `K${i + 1}`)),
    ...Z.map((e, i) => user(`z${i + 1}`, e, "rola_czlonek", `Z${i + 1}`)),
  ];
  return new FakeFirestore({setup: [{_docId: "vars_members", vars: v}], users_active: users, ...extra});
}

function mkRes() {
  const out: any = {status: 0, body: null, html: ""};
  const res: any = {
    setHeader: () => res,
    type: () => res,
    status(c: number) {
      out.status = c;
      return res;
    },
    json(b: any) {
      out.body = b;
      return res;
    },
    send(h: string) {
      out.html = h;
      return res;
    },
  };
  return {res, out};
}

async function api(db: FakeFirestore, uid: string | null, method: string, route: string, body: any = {}, today = "2026-09-10", query: any = {}) {
  const {res, out} = mkRes();
  let pending: Promise<void> = Promise.resolve();
  const email = uid ? ((db.dump("users_active") as any[]).find((u) => u._docId === uid || u.uid === uid)?.email) : undefined;
  await handleBlachyApi({method, path: `/api/blachy/${route}`, headers: {}, body, query} as any, res, {
    db: db as any, sendPreflight: () => false, requireAllowedHost: () => true, setCorsHeaders: () => undefined,
    corsHandler: (_q: any, _s: any, f: any) => {
      pending = f();
    },
    requireIdToken: async () => (uid ? {decoded: {uid, email}} : {error: "no token"}),
    today: () => today,
  });
  await pending;
  return out;
}

function ctx(db: FakeFirestore) {
  const mails: Array<{to: string; subject: string; text: string}> = [];
  const workspace: any = {
    sendGenericEmailHtml: async (to: string, subject: string, text: string) => {
      mails.push({to, subject, text});
    },
  };
  const logger = {info: () => undefined, warn: () => undefined, error: () => undefined};
  return {c: {firestore: db as any, now: new Date(), dryRun: false, workspace, config: {} as any, logger}, mails};
}

const nom = (kandydat: any) => ({action: "add", data: {kandydat, obszary: ["Budowanie społeczności", "x"],
  zaslugi: "Organizuje wyjazdy od dziesięciu lat.", uzasadnienie: "Buduje społeczność klubu od lat."}});

describe("konfiguracja i reguły", () => {
  it("terminy z SETUP (różne formaty) + domyślne z regulaminu; fazy; edycja Rejestru", () => {
    const cfg = parseBlachyConfig(vars({blachy_glosowanie_do: "2030-10-20"}), "2026-05-01");
    expect([cfg.nominacjeOd, cfg.nominacjeDo, cfg.weryfikacjaDo, cfg.glosowanieDo]).toEqual(["2026-09-01", "2026-09-30", "2026-10-15", "2026-10-20"]);
    expect(faza(cfg, "2026-08-31")).toBe("przed");
    expect(faza(cfg, "2026-09-30")).toBe("nominacje");
    expect(faza(cfg, "2026-10-16")).toBe("glosowanie");
    expect(faza(parseBlachyConfig(vars({blachy_procedura: "FALSE"}), "2026-09-10"), "2026-09-10")).toBe("wylaczona");
    expect(canEditRegistry(cfg, "zar@x.pl", true)).toBe(true);
    expect(canEditRegistry(parseBlachyConfig(vars({blachy_edycja_zarzad: "FALSE"}), "2026-09-10"), "zar@x.pl", true)).toBe(false);
    expect(canEditRegistry(parseBlachyConfig(vars({blachy_edycja_zarzad: "FALSE"}), "2026-09-10"), K[2], false)).toBe(true);
  });

  it("miejsca: kandydat i konflikt interesów → zastępca; obaj wyłączeni → puste", () => {
    const cfg = parseBlachyConfig(vars(), "2026-09-10");
    const s = seatVoters(cfg, K[1], [K[2], K[3], Z[3]]);
    expect(s.map((x) => x.email)).toEqual([K[0], Z[1], Z[2], null, K[4]]);
  });

  it("klucz kandydata, walidacja, numeracja po archiwum (od 40)", () => {
    expect(candidateKey({uid: "abc"})).toBe("u_abc");
    expect(candidateKey({imie: "Łukasz", nazwisko: "Opałka"})).toBe("n_lukasz_opalka");
    expect(validateNominacja({kandydat: {}, zaslugi: "krótko", uzasadnienie: ""}).ok).toBe(false);
    expect(nextNumer([null, undefined])).toBe(40);
    expect(nextNumer([0, 39, null])).toBe(40);
    expect(nextNumer([42, 50, null])).toBe(51);
  });
});

describe("nominacje", () => {
  it("członek zgłasza (dane z konta, nie z formularza) + mail potwierdzający; sympatyk 403; poza oknem 409", async () => {
    const db = seed();
    const r = await api(db, "ala", "POST", "nominacja", nom({uid: "bob", imie: "Podróba"}));
    expect(r.status).toBe(200);
    const n = (db.dump("blachy_nominacje") as any[])[0];
    expect(n).toMatchObject({rok: 2026, autorEmail: "ala@x.pl", candidateKey: "u_bob", status: "zlozona", obszary: ["Budowanie społeczności"]});
    expect(n.kandydat).toMatchObject({imie: "Bob", nazwisko: "Kowal", email: "bob@x.pl"});
    expect((db.dump("service_jobs") as any[]).map((j) => j.taskId)).toEqual(["blachy.nominacjaMail"]);
    expect((await api(db, "sym", "POST", "nominacja", nom({uid: "bob"}))).status).toBe(403);
    expect((await api(db, "ala", "POST", "nominacja", nom({uid: "bob"}), "2026-10-01")).status).toBe(409);
  });

  it("blokady: siebie, osoba z blachą w Rejestrze; moje zgłoszenia + wycofanie", async () => {
    const db = seed({blachy: [{_docId: "bo_1", imie: "Bob", nazwisko: "Kowal", email: "bob@x.pl"}]});
    expect((await api(db, "ala", "POST", "nominacja", nom({uid: "ala"}))).body.error).toMatch(/samego siebie/);
    expect((await api(db, "ala", "POST", "nominacja", nom({uid: "bob"}))).body.error).toMatch(/ma już Blachę/);
    const ok = await api(db, "ala", "POST", "nominacja", nom({imie: "Jan", nazwisko: "Obcy", klub: "KK Wiking"}));
    expect(ok.status).toBe(200);
    const st = await api(db, "ala", "GET", "stan");
    expect(st.body.moje.map((m: any) => m.label)).toEqual(["Jan Obcy (KK Wiking)"]);
    expect(st.body.osoby.find((o: any) => o.uid === "bob").hasBlacha).toBe(true);
    expect(st.body.osoby.some((o: any) => o.uid === "ala")).toBe(false);
    await api(db, "ala", "POST", "nominacja", {action: "withdraw", id: ok.body.id});
    expect((await api(db, "ala", "GET", "stan")).body.moje).toEqual([]);
  });
});

async function closedWithTwoCandidates() {
  const db = seed();
  await api(db, "ala", "POST", "nominacja", nom({uid: "bob"}));
  await api(db, Z[0].split("@")[0], "POST", "nominacja", nom({uid: "bob"}));
  await api(db, "ala", "POST", "nominacja", nom({uid: "k2"}));
  return db;
}

describe("Kapituła i tajne głosowanie", () => {
  it("po zamknięciu: zgłoszenia połączone per osoba; tylko skład Kapituły", async () => {
    const db = await closedWithTwoCandidates();
    expect((await api(db, "ala", "GET", "kapitula", {}, "2026-10-01")).status).toBe(403);
    const r = await api(db, "k3", "GET", "kapitula", {}, "2026-10-01");
    expect(r.status).toBe(200);
    const bob = r.body.kandydatury.find((k: any) => k.label === "Bob Kowal");
    expect(bob.nominacje).toHaveLength(2);
    expect(r.body.kandydatury).toHaveLength(2);
  });

  it("kandydat w Kapitule → głosuje zastępca; 5 głosów → decyzja; brak wyników cząstkowych; brak zapisu osoba↔głos", async () => {
    const db = await closedWithTwoCandidates();
    await api(db, "k1", "GET", "kapitula", {}, "2026-10-01");
    const id = "2026_u_k2";
    expect((await api(db, "k2", "POST", "kapitula", {action: "open", id}, "2026-10-02")).status).toBe(403);
    expect((await api(db, "k1", "POST", "kapitula", {action: "open", id}, "2026-10-02")).body.status).toBe("otwarte");

    expect((await api(db, "k2", "POST", "kapitula", {action: "vote", id, glos: "tak"}, "2026-10-02")).status).toBe(403);
    for (const v of ["k1", "z2", "k3", "k4"]) {
      expect((await api(db, v, "POST", "kapitula", {action: "vote", id, glos: v === "k4" ? "nie" : "tak"}, "2026-10-02")).status).toBe(200);
    }
    expect((await api(db, "k1", "POST", "kapitula", {action: "vote", id, glos: "tak"}, "2026-10-02")).status).toBe(409);
    const mid = await api(db, "k1", "GET", "kapitula", {}, "2026-10-02");
    const kMid = mid.body.kandydatury.find((k: any) => k.id === id);
    expect([kMid.oddane, kMid.wynik, kMid.decyzja]).toEqual([4, null, null]);

    await api(db, "k5", "POST", "kapitula", {action: "vote", id, glos: "tak"}, "2026-10-02");
    const end = (await api(db, "k1", "GET", "kapitula", {}, "2026-10-02")).body.kandydatury.find((k: any) => k.id === id);
    expect([end.status, end.decyzja, end.wynik]).toEqual(["zakonczone", "wybrany", {tak: 4, nie: 1}]);

    const kandDoc = (db.dump("blachy_kandydatury") as any[]).find((k) => k._docId === id || k.key === "u_k2");
    expect(JSON.stringify(kandDoc.oddali)).not.toMatch(/@/);
    expect(JSON.stringify(db.dump(`blachy_kandydatury/${id}/tajne`))).not.toMatch(/@/);
  });

  it("konflikt dwóch osób z tego samego miejsca → odroczone; łączenie kandydatur przez przewodniczącego", async () => {
    const db = await closedWithTwoCandidates();
    await api(db, "k1", "GET", "kapitula", {}, "2026-10-01");
    await api(db, "k3", "POST", "kapitula", {action: "conflict", id: "2026_u_bob"}, "2026-10-01");
    await api(db, "z3", "POST", "kapitula", {action: "conflict", id: "2026_u_bob"}, "2026-10-01");
    expect((await api(db, "k1", "POST", "kapitula", {action: "open", id: "2026_u_bob"}, "2026-10-02")).body.status).toBe("odroczone");
    expect((await api(db, "k1", "POST", "kapitula", {action: "merge", id: "2026_u_k2", into: "2026_u_bob"}, "2026-10-02")).status).toBe(409);
  });
});

async function votedYes(db: FakeFirestore, id: string) {
  await api(db, "k1", "POST", "kapitula", {action: "open", id}, "2026-10-02");
  const cand = (db.dump("blachy_kandydatury") as any[]).find((k) => `2026_${k.key}` === id);
  for (const s of ["1", "2", "3", "4", "5"]) {
    const mail = cand.glosujacy[s];
    const uid = mail.split("@")[0];
    await api(db, uid, "POST", "kapitula", {action: "vote", id, glos: "tak"}, "2026-10-02");
  }
}

describe("Zarząd, przyjęcie, ogłoszenie, sprzątanie", () => {
  it("pełny przebieg: zatwierdzenie → link przyjęcia → ogłoszenie (Rejestr nr 40, lista, zgłaszający)", async () => {
    const db = await closedWithTwoCandidates();
    await api(db, "k1", "GET", "kapitula", {}, "2026-10-01");
    await votedYes(db, "2026_u_bob");
    await api(db, "k1", "POST", "kapitula", {action: "invalidate", id: "2026_u_k2"}, "2026-10-02");

    expect((await api(db, "zar", "POST", "zarzad", {action: "approve", uchwala: "12/2026"}, "2026-11-01")).body.error).toMatch(/uzasadnień/);
    await api(db, "k1", "POST", "kapitula", {action: "uzasadnienie", id: "2026_u_bob", text: "Wieloletni organizator wypraw."}, "2026-10-20");
    expect((await api(db, "ala", "POST", "zarzad", {action: "approve", uchwala: "x"}, "2026-11-01")).status).toBe(403);
    const z = await api(db, "zar", "GET", "zarzad", {}, "2026-11-01");
    expect(z.body.wybrani.map((w: any) => w.label)).toEqual(["Bob Kowal"]);
    expect(z.body.liczby.kandydatury).toBe(1);
    expect((await api(db, "zar", "POST", "zarzad", {action: "approve", uchwala: "12/2026"}, "2026-11-01")).status).toBe(200);

    const {c, mails} = ctx(db);
    await blachyRequestAcceptanceTask.run({rok: 2026}, c);
    expect(mails.map((m) => m.to)).toEqual(["bob@x.pl"]);
    const token = /t=([a-f0-9]{48})/.exec(mails[0].text)?.[1];
    expect((await api(db, "zar", "POST", "zarzad", {action: "announce"}, "2026-11-02")).body.error).toMatch(/potwierdzenie/);
    const page = await api(db, null, "GET", "przyjecie", {}, "2026-11-02", {t: token, d: "tak"});
    expect(page.html).toMatch(/Dziękujemy/);

    expect((await api(db, "zar", "POST", "zarzad", {action: "announce"}, "2026-11-02")).status).toBe(200);
    mails.length = 0;
    const res = await blachyAnnounceTask.run({rok: 2026}, c);
    expect(res.ok).toBe(true);
    const reg = (db.dump("blachy") as any[]).find((b) => b.zrodlo === "procedura");
    expect(reg).toMatchObject({imie: "Bob", nazwisko: "Kowal", rok: 2026, nr: 40, uzasadnienie: "Wieloletni organizator wypraw."});
    const lista = mails.find((m) => m.to === "lista@morzkulc.pl");
    expect(lista?.text).toMatch(/Rozpatrzone kandydatury: 1/);
    expect(lista?.text).not.toMatch(/K2/);
    expect(mails.filter((m) => m.subject.includes("rozpatrzone")).map((m) => m.to).sort()).toEqual(["ala@x.pl", "z1@x.pl"]);
  });

  it("zwrot przez Zarząd → przewodniczący może rozpatrzyć ponownie", async () => {
    const db = await closedWithTwoCandidates();
    await api(db, "k1", "GET", "kapitula", {}, "2026-10-01");
    await votedYes(db, "2026_u_bob");
    expect((await api(db, "k1", "POST", "kapitula", {action: "reset", id: "2026_u_bob"}, "2026-10-20")).status).toBe(409);
    await api(db, "zar", "POST", "zarzad", {action: "return", powod: "§5 pkt 6 — brak kworum"}, "2026-11-01");
    expect((await api(db, "k1", "POST", "kapitula", {action: "reset", id: "2026_u_bob"}, "2026-11-01")).status).toBe(200);
    expect((db.dump("blachy_kandydatury") as any[]).find((k) => k.key === "u_bob").status).toBe("do_weryfikacji");
  });

  it("zadanie dzienne: otwarcie raz, przypomnienie, zestawienie (1 mail na osobę Kapituły) + zamknięcie", async () => {
    const db = await closedWithTwoCandidates();
    const {c, mails} = ctx(db);
    await blachyDailyTask.run({today: "2026-09-01"}, c);
    await blachyDailyTask.run({today: "2026-09-02"}, c);
    expect(mails.filter((m) => m.to === "lista@morzkulc.pl").map((m) => m.subject)).toEqual(["Blachy Klubowe 2026: zgłaszanie kandydatów do 30 września 2026"]);
    await blachyDailyTask.run({today: "2026-09-23"}, c);
    expect(mails.at(-1)?.subject).toMatch(/jeszcze do/);
    mails.length = 0;
    await blachyDailyTask.run({today: "2026-10-01"}, c);
    const dossier = mails.filter((m) => m.subject.includes("zestawienie"));
    expect(dossier.map((m) => m.to).sort()).toEqual([...K, ...Z].sort());
    expect(dossier[0].text).toMatch(/Bob Kowal/);
    expect(mails.find((m) => m.to === "lista@morzkulc.pl")?.text).not.toMatch(/Bob/);
    mails.length = 0;
    await blachyDailyTask.run({today: "2026-10-02"}, c);
    expect(mails).toHaveLength(0);
  });
});
