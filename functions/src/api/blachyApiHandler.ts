/* eslint-disable require-jsdoc */
import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import {norm} from "../modules/shared/text_utils";
import {todayWarsawIso} from "../modules/shared/date_range_utils";
import {BLACHY_COLLECTION, findInRegistry} from "../modules/blachy/blachy_registry";
import {
  KANDYDATURY_COLLECTION, NOMINACJE_COLLECTION, NOMINUJACE_ROLE, OBSZARY, PROG_WYBORU, SEATS,
  candidateKey, faza, isKapitula, kandydatLabel, validateNominacja,
} from "../modules/blachy/blachy_procedura";
import {
  BlachyContext, castVote, compileKandydatury, enqueueJob, httpError, listKandydatury, loadBlachyContext,
  openVoting, resetKandydatura, stateRef, userName,
} from "../modules/blachy/blachy_service";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string}};

export type BlachyApiDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
  today?: () => string;
};

type Me = {uid: string; email: string; name: string; role: string; status: string};

const str = (v: any) => String(v == null ? "" : v).trim();
const ts = () => admin.firestore.FieldValue.serverTimestamp();

/**
 * /api/blachy/* — procedura nadawania Blach (regulamin v3.2):
 *  GET  stan        — faza, terminy, skład Kapituły, moje zgłoszenia, uprawnienia
 *  POST nominacja   — add / update / withdraw (aktualni członkowie, okno nominacji)
 *  GET  kapitula    — zestawienie kandydatur + głosowanie (tylko skład Kapituły)
 *  POST kapitula    — conflict / unconflict / merge / invalidate / restore / open / vote / uzasadnienie / reset
 *  GET  zarzad      — wyniki do zatwierdzenia (rola zarząd)
 *  POST zarzad      — approve / return / accept_manual / announce
 *  GET  przyjecie   — link z maila do wyróżnionego (bez logowania; token)
 */
export async function handleBlachyApi(req: Request, res: Response, deps: BlachyApiDeps) {
  const {sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, db} = deps;
  if (sendPreflight(req, res)) return;
  if (!requireAllowedHost(req, res)) return;
  setCorsHeaders(req, res);

  corsHandler(req, res, async () => {
    const route = str(req.path || (req as any).url).split("?")[0].replace(/\/+$/, "").split("/").pop() || "";
    const today = deps.today ? deps.today() : todayWarsawIso();
    try {
      if (route === "przyjecie" && req.method === "GET") {
        await przyjecie(req, res, db);
        return;
      }
      const tokenCheck = await deps.requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }
      const uSnap = await db.collection("users_active").doc(tokenCheck.decoded.uid).get();
      const u = (uSnap.data() as any) || {};
      const me: Me = {
        uid: tokenCheck.decoded.uid,
        email: norm(tokenCheck.decoded.email || u.email).toLowerCase(),
        name: userName(u),
        role: norm(u.role_key),
        status: norm(u.status_key),
      };
      const ctx = await loadBlachyContext(db, today);
      const key = `${req.method} ${route}`;
      if (key === "GET stan") return void res.status(200).json(await stan(db, ctx, me, today));
      if (key === "POST nominacja") return void res.status(200).json(await nominacja(db, ctx, me, today, req.body));
      if (key === "GET kapitula") return void res.status(200).json(await kapitulaGet(db, ctx, me, today));
      if (key === "POST kapitula") return void res.status(200).json(await kapitulaPost(db, ctx, me, today, req.body));
      if (key === "GET zarzad") return void res.status(200).json(await zarzadGet(db, ctx, me));
      if (key === "POST zarzad") return void res.status(200).json(await zarzadPost(db, ctx, me, req.body));
      res.status(404).json({error: "Not found"});
    } catch (err: any) {
      if (err?.status) {
        res.status(err.status).json({error: err.message, ...(err.fields ? {fields: err.fields} : {})});
        return;
      }
      logger.error("blachyApi failed", {route, message: err?.message, stack: err?.stack});
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}

const canNominate = (me: Me) => NOMINUJACE_ROLE.includes(me.role) && me.status === "status_aktywny";

async function usersByEmail(db: FirebaseFirestore.Firestore) {
  const s = await db.collection("users_active").get();
  const m = new Map<string, any>();
  s.docs.forEach((d) => m.set(norm((d.data() as any).email).toLowerCase(), {uid: d.id, ...(d.data() as any)}));
  return {all: s.docs.map((d) => ({uid: d.id, ...(d.data() as any)})), byEmail: m};
}

async function registry(db: FirebaseFirestore.Firestore) {
  return (await db.collection(BLACHY_COLLECTION).get()).docs.map((d) => ({id: d.id, d: d.data() as any}));
}

// ── stan ────────────────────────────────────────────────────────────────────
async function stan(db: FirebaseFirestore.Firestore, ctx: BlachyContext, me: Me, today: string) {
  const {cfg} = ctx;
  const f = faza(cfg, today);
  const users = await usersByEmail(db);
  const nameOf = (e: string) => (e ? (users.byEmail.get(e) ? userName(users.byEmail.get(e)) : e) : "");
  const st = (await stateRef(db, cfg.rok).get()).data() as any || {};
  const moje = cfg.wlaczona ? (await db.collection(NOMINACJE_COLLECTION).where("autorUid", "==", me.uid).get()).docs
    .map((d) => ({id: d.id, ...(d.data() as any)}))
    .filter((n) => n.rok === cfg.rok && n.status !== "wycofana")
    .map((n) => ({id: n.id, kandydat: n.kandydat, label: kandydatLabel(n.kandydat || {}), obszary: n.obszary || [],
      zaslugi: n.zaslugi, uzasadnienie: n.uzasadnienie, status: n.status})) : [];

  let osoby: Array<{uid: string; label: string; hasBlacha: boolean}> | undefined;
  if (f === "nominacje" && canNominate(me)) {
    const reg = await registry(db);
    osoby = users.all
      .filter((u) => u.uid !== me.uid && userName(u))
      .map((u) => ({
        uid: u.uid, label: userName(u),
        hasBlacha: Boolean(findInRegistry(reg, {email: norm(u.email).toLowerCase(), memberId: u.memberId ?? null,
          imie: str(u.profile?.firstName), nazwisko: str(u.profile?.lastName)})),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, "pl"));
  }

  return {
    ok: true, rok: cfg.rok, faza: f, wlaczona: cfg.wlaczona,
    terminy: {nominacjeOd: cfg.nominacjeOd, nominacjeDo: cfg.nominacjeDo, weryfikacjaDo: cfg.weryfikacjaDo,
      glosowanieDo: cfg.glosowanieDo, zatwierdzenieDo: cfg.zatwierdzenieDo},
    kapitula: cfg.kapitula.map((s) => ({seat: s.seat, czlonek: nameOf(s.czlonek), zastepca: nameOf(s.zastepca)})),
    przewodniczacy: nameOf(cfg.przewodniczacy),
    obszary: OBSZARY,
    canNominate: f === "nominacje" && canNominate(me),
    isKapitula: isKapitula(cfg, me.email),
    isZarzad: me.role === "rola_zarzad",
    ogloszono: Boolean(st.ogloszenieAt),
    moje,
    ...(osoby ? {osoby} : {}),
  };
}

// ── nominacje (§3) ──────────────────────────────────────────────────────────
async function nominacja(db: FirebaseFirestore.Firestore, ctx: BlachyContext, me: Me, today: string, body: any) {
  const {cfg} = ctx;
  if (faza(cfg, today) !== "nominacje") throw httpError(409, "Nominacje są zamknięte");
  if (!canNominate(me)) throw httpError(403, "Kandydatów zgłaszają aktualni członkowie Klubu");
  const action = norm(body?.action);
  const col = db.collection(NOMINACJE_COLLECTION);

  if (action === "withdraw" || action === "update") {
    const ref = col.doc(str(body?.id));
    const s = await ref.get();
    const n = s.data() as any;
    if (!s.exists || n.autorUid !== me.uid || n.status !== "zlozona") throw httpError(404, "Nie ma takiego zgłoszenia");
    if (action === "withdraw") {
      await ref.update({status: "wycofana", updatedAt: ts()});
      return {ok: true};
    }
  }
  if (action !== "add" && action !== "update") throw httpError(400, "Nieznana akcja");

  const v = validateNominacja(body?.data);
  if (!v.ok) throw Object.assign(httpError(400, "Popraw pola"), {fields: v.fields});
  const kandydat = {...v.data.kandydat};
  let memberId: number | null = null;
  if (kandydat.uid) {
    const us = await db.collection("users_active").doc(kandydat.uid).get();
    if (!us.exists) throw httpError(400, "Nie ma takiej osoby");
    const u = us.data() as any;
    kandydat.imie = str(u.profile?.firstName);
    kandydat.nazwisko = str(u.profile?.lastName);
    kandydat.ksywa = str(u.profile?.nickname);
    kandydat.email = norm(u.email).toLowerCase();
    kandydat.klub = "";
    memberId = u.memberId ?? null;
  }
  if (kandydat.uid === me.uid || (kandydat.email && kandydat.email === me.email)) throw httpError(409, "Nie można zgłosić samego siebie (§3 pkt 2)");
  const hit = findInRegistry(await registry(db), {email: kandydat.email, memberId, imie: kandydat.imie, nazwisko: kandydat.nazwisko});
  if (hit) throw httpError(409, "Ta osoba ma już Blachę Klubową (Rejestr Blach)");

  const doc = {
    rok: cfg.rok, kandydat, candidateKey: candidateKey(kandydat), obszary: v.data.obszary,
    zaslugi: v.data.zaslugi, uzasadnienie: v.data.uzasadnienie, updatedAt: ts(),
  };
  if (action === "update") {
    await col.doc(str(body?.id)).update(doc);
    return {ok: true, id: str(body?.id)};
  }
  const ref = col.doc();
  await ref.set({...doc, autorUid: me.uid, autorEmail: me.email, autorName: me.name, status: "zlozona", createdAt: ts()});
  await enqueueJob(db, "blachy.nominacjaMail", {id: ref.id});
  return {ok: true, id: ref.id};
}

// ── Kapituła (§4–§5) ────────────────────────────────────────────────────────
function requireKapitula(ctx: BlachyContext, me: Me) {
  if (!isKapitula(ctx.cfg, me.email)) throw httpError(403, "Tylko dla składu Kapituły");
}
function requirePrzewodniczacy(ctx: BlachyContext, me: Me) {
  if (!ctx.cfg.przewodniczacy || ctx.cfg.przewodniczacy !== me.email) throw httpError(403, "Tylko przewodniczący Kapituły");
}

async function kapitulaGet(db: FirebaseFirestore.Firestore, ctx: BlachyContext, me: Me, today: string) {
  requireKapitula(ctx, me);
  const {cfg} = ctx;
  const f = faza(cfg, today);
  if (f !== "przed" && f !== "nominacje" && f !== "wylaczona") await compileKandydatury(db, cfg.rok);
  const st = (await stateRef(db, cfg.rok).get()).data() as any || {};
  const kands = await listKandydatury(db, cfg.rok);
  const items = [];
  for (const k of kands) {
    const noms = await Promise.all((k.nominacjeIds || []).map((id: string) => db.collection(NOMINACJE_COLLECTION).doc(id).get()));
    const mySeat = Object.entries(k.glosujacy || {}).find(([, e]) => e === me.email)?.[0] || null;
    items.push({
      id: k.id, label: k.label, spozaKlubu: !str(k.kandydat?.uid), status: k.status,
      nominacje: noms.filter((s) => s.exists).map((s) => {
        const n = s.data() as any;
        return {autor: str(n.autorName) || str(n.autorEmail), obszary: n.obszary || [], zaslugi: n.zaslugi, uzasadnienie: n.uzasadnienie};
      }),
      wylaczonyJa: (k.wylaczeni || []).includes(me.email),
      glosujeJa: Boolean(mySeat),
      oddalemJa: Boolean(mySeat && (k.oddali || []).includes(mySeat)),
      oddane: (k.oddali || []).length,
      // Sumy dopiero po oddaniu wszystkich głosów — brak wyników cząstkowych.
      wynik: k.status === "zakonczone" ? k.wynik : null,
      decyzja: k.decyzja || null,
      uzasadnienieKapituly: str(k.uzasadnienieKapituly),
      przyjecie: k.przyjecie?.status || null,
    });
  }
  return {
    ok: true, rok: cfg.rok, faza: f, isPrzewodniczacy: cfg.przewodniczacy === me.email,
    seats: SEATS, prog: PROG_WYBORU,
    zwrot: st.zwrot?.powod || null, zatwierdzono: Boolean(st.zatwierdzenie), ogloszono: Boolean(st.ogloszenieAt),
    kandydatury: items,
  };
}

async function kapitulaPost(db: FirebaseFirestore.Firestore, ctx: BlachyContext, me: Me, today: string, body: any) {
  requireKapitula(ctx, me);
  const {cfg} = ctx;
  const f = faza(cfg, today);
  const action = norm(body?.action);
  const ref = db.collection(KANDYDATURY_COLLECTION).doc(str(body?.id));
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "Nie ma takiej kandydatury");
  const k = snap.data() as any;
  if (k.rok !== cfg.rok) throw httpError(409, "Kandydatura z innego roku");
  const st = (await stateRef(db, cfg.rok).get()).data() as any || {};
  if (st.zatwierdzenie && action !== "vote") throw httpError(409, "Wyniki są już zatwierdzone przez Zarząd");
  const weryfikacja = () => {
    if (k.status !== "do_weryfikacji") throw httpError(409, "Kandydatura nie jest w weryfikacji");
  };

  switch (action) {
  case "conflict":
  case "unconflict": {
    weryfikacja();
    const set = new Set<string>(k.wylaczeni || []);
    if (action === "conflict") set.add(me.email);
    else set.delete(me.email);
    await ref.update({wylaczeni: [...set], updatedAt: ts()});
    return {ok: true};
  }
  case "merge": {
    requirePrzewodniczacy(ctx, me);
    weryfikacja();
    const intoRef = db.collection(KANDYDATURY_COLLECTION).doc(str(body?.into));
    const into = await intoRef.get();
    if (!into.exists || (into.data() as any).status !== "do_weryfikacji" || intoRef.id === ref.id) throw httpError(409, "Wybierz inną kandydaturę w weryfikacji");
    const ids: string[] = k.nominacjeIds || [];
    await intoRef.update({nominacjeIds: [...((into.data() as any).nominacjeIds || []), ...ids], updatedAt: ts()});
    for (const id of ids) await db.collection(NOMINACJE_COLLECTION).doc(id).update({kandydaturaId: intoRef.id});
    await ref.delete();
    return {ok: true};
  }
  case "invalidate":
    requirePrzewodniczacy(ctx, me);
    weryfikacja();
    await ref.update({status: "nieprawidlowa", updatedAt: ts()});
    return {ok: true};
  case "restore":
    requirePrzewodniczacy(ctx, me);
    if (k.status !== "nieprawidlowa") throw httpError(409, "Kandydatura nie jest odrzucona");
    await ref.update({status: "do_weryfikacji", updatedAt: ts()});
    return {ok: true};
  case "open": {
    requirePrzewodniczacy(ctx, me);
    if (f !== "weryfikacja" && f !== "glosowanie") throw httpError(409, "Głosowanie odbywa się po zamknięciu nominacji, do końca terminu głosowania");
    return {ok: true, status: await openVoting(db, cfg, ref.id)};
  }
  case "vote": {
    const glos = norm(body?.glos);
    if (glos !== "tak" && glos !== "nie") throw httpError(400, "Głos: tak albo nie");
    return {ok: true, ...(await castVote(db, ref.id, me.email, glos))};
  }
  case "uzasadnienie": {
    requirePrzewodniczacy(ctx, me);
    if (k.decyzja !== "wybrany") throw httpError(409, "Uzasadnienie dotyczy kandydatów wybranych");
    await ref.update({uzasadnienieKapituly: str(body?.text).slice(0, 4000), updatedAt: ts()});
    return {ok: true};
  }
  case "reset":
    requirePrzewodniczacy(ctx, me);
    if (!st.zwrot) throw httpError(409, "Ponowne rozpatrzenie tylko po zwrocie sprawy przez Zarząd");
    await resetKandydatura(db, ref.id);
    return {ok: true};
  default:
    throw httpError(400, "Nieznana akcja");
  }
}

// ── Zarząd (§5 pkt 5, 7) ────────────────────────────────────────────────────
async function zarzadGet(db: FirebaseFirestore.Firestore, ctx: BlachyContext, me: Me) {
  if (me.role !== "rola_zarzad") throw httpError(403, "Tylko Zarząd");
  const {cfg} = ctx;
  const st = (await stateRef(db, cfg.rok).get()).data() as any || {};
  const kands = await listKandydatury(db, cfg.rok);
  const rozpatrywane = kands.filter((k) => k.status !== "nieprawidlowa");
  return {
    ok: true, rok: cfg.rok,
    // Bez liczby kandydatur (tajna, §6 pkt 2): tylko czy Kapituła skończyła i kogo wybrała.
    gotowe: !rozpatrywane.some((k) => k.status === "do_weryfikacji" || k.status === "otwarte"),
    // Zarząd widzi wyłącznie wybranych (reszta jest tajna, §6 pkt 2).
    wybrani: rozpatrywane.filter((k) => k.decyzja === "wybrany").map((k) => ({
      id: k.id, label: k.label, uzasadnienie: str(k.uzasadnienieKapituly), przyjecie: k.przyjecie?.status || null,
      maMail: Boolean(str(k.kandydat?.email)),
    })),
    zatwierdzenie: st.zatwierdzenie ? {uchwala: st.zatwierdzenie.uchwala, przez: st.zatwierdzenie.by} : null,
    zwrot: st.zwrot?.powod || null,
    ogloszono: Boolean(st.ogloszenieAt),
  };
}

async function zarzadPost(db: FirebaseFirestore.Firestore, ctx: BlachyContext, me: Me, body: any) {
  if (me.role !== "rola_zarzad") throw httpError(403, "Tylko Zarząd");
  const {cfg} = ctx;
  const sRef = stateRef(db, cfg.rok);
  const st = (await sRef.get()).data() as any || {};
  if (st.ogloszenieAt) throw httpError(409, "Wyniki już ogłoszone");
  const kands = (await listKandydatury(db, cfg.rok)).filter((k) => k.status !== "nieprawidlowa");
  const wybrani = kands.filter((k) => k.decyzja === "wybrany");
  const action = norm(body?.action);

  if (action === "approve") {
    if (kands.some((k) => k.status === "do_weryfikacji" || k.status === "otwarte")) throw httpError(409, "Kapituła nie zakończyła głosowań");
    if (wybrani.some((k) => !str(k.uzasadnienieKapituly))) throw httpError(409, "Kapituła nie dodała uzasadnień dla wszystkich wybranych");
    const uchwala = str(body?.uchwala).slice(0, 200);
    if (!uchwala) throw httpError(400, "Podaj numer / datę uchwały");
    await sRef.set({zatwierdzenie: {uchwala, by: me.email, at: ts()}, zwrot: admin.firestore.FieldValue.delete()}, {merge: true});
    await enqueueJob(db, "blachy.requestAcceptance", {rok: cfg.rok});
    return {ok: true};
  }
  if (action === "return") {
    const powod = str(body?.powod).slice(0, 2000);
    if (!powod) throw httpError(400, "Podaj, który przepis regulaminu został naruszony");
    await sRef.set({zwrot: {powod, by: me.email, at: ts()}, zatwierdzenie: admin.firestore.FieldValue.delete()}, {merge: true});
    return {ok: true};
  }
  if (action === "accept_manual") {
    const k = wybrani.find((x) => x.id === str(body?.id));
    const status = norm(body?.status);
    if (!k || !st.zatwierdzenie || (status !== "przyjeta" && status !== "odmowa")) throw httpError(409, "Nie można zmienić statusu przyjęcia");
    await k.ref.update({"przyjecie.status": status, "przyjecie.recznie": me.email, "updatedAt": ts()});
    return {ok: true};
  }
  if (action === "announce") {
    if (!st.zatwierdzenie) throw httpError(409, "Najpierw zatwierdź wyniki uchwałą");
    if (wybrani.some((k) => !["przyjeta", "odmowa"].includes(k.przyjecie?.status))) throw httpError(409, "Czekamy na potwierdzenie przyjęcia przez wszystkich wyróżnionych");
    await sRef.set({ogloszenieZlecone: ts()}, {merge: true});
    await enqueueJob(db, "blachy.announce", {rok: cfg.rok});
    return {ok: true};
  }
  throw httpError(400, "Nieznana akcja");
}

// ── Potwierdzenie przyjęcia (link z maila, bez logowania) ───────────────────

async function przyjecie(req: Request, res: Response, db: FirebaseFirestore.Firestore) {
  const token = str(req.query?.t);
  const decyzja = norm(req.query?.d) === "nie" ? "odmowa" : "przyjeta";
  const page = (msg: string) => res.status(200).type("html").send(
    "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>SKK Morzkulc</title>" +
    `<div style="font-family:Arial,sans-serif;max-width:560px;margin:60px auto;padding:0 16px;font-size:17px;line-height:1.5">${msg}</div>`);
  if (!/^[a-f0-9]{48}$/.test(token)) return void page("Nieprawidłowy link.");
  const q = await db.collection(KANDYDATURY_COLLECTION).where("przyjecie.token", "==", token).limit(1).get();
  if (q.empty) return void page("Link wygasł albo jest nieprawidłowy.");
  const ref = q.docs[0].ref;
  const k = q.docs[0].data() as any;
  if (k.przyjecie?.status !== "oczekuje") return void page("Odpowiedź została już zapisana. Dziękujemy.");
  await ref.update({"przyjecie.status": decyzja, "przyjecie.at": ts()});
  page(decyzja === "przyjeta" ?
    "Dziękujemy. Potwierdzenie przyjęcia Blachy Klubowej Morzkulca zostało zapisane. Do ogłoszenia prosimy o zachowanie tej informacji dla siebie." :
    "Dziękujemy za odpowiedź. Zapisaliśmy, że nie przyjmujesz wyróżnienia.");
}
