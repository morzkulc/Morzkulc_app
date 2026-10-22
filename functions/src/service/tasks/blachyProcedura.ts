import * as admin from "firebase-admin";
import {ServiceTask} from "../types";
import {minusDays, todayWarsawIso} from "../../modules/shared/date_range_utils";
import {BLACHY_COLLECTION} from "../../modules/blachy/blachy_registry";
import {
  DNI_DO_USUNIECIA, NOMINACJE_COLLECTION, dzienPrzypomnienia, kandydatLabel, kapitulaEmails, nextNumer,
} from "../../modules/blachy/blachy_procedura";
import {
  mailDossier, mailNominacjaPotwierdzenie, mailOgloszenie, mailOtwarcie, mailPrzyjecie, mailPrzypomnienie,
  mailRozpatrzona, mailZamkniecie,
} from "../../modules/blachy/blachy_mail";
import {
  acceptanceToken, buildDossier, compileKandydatury, listKandydatury, loadBlachyContext, purgeRok, stateRef,
} from "../../modules/blachy/blachy_service";

const str = (v: any) => String(v == null ? "" : v).trim();
const ts = () => admin.firestore.FieldValue.serverTimestamp();

type DailyPayload = {today?: string};

/**
 * Codziennie (scheduler blachyDaily): maile na listę w terminach z SETUP (otwarcie, przypomnienie,
 * zamknięcie), po zamknięciu nominacji — kandydatury + JEDNO zestawienie do każdego członka Kapituły,
 * 14 dni po ogłoszeniu — usunięcie treści nominacji i sum głosów. Każdy krok raz (znaczniki w blachy_procedura/{rok}).
 */
export const blachyDailyTask: ServiceTask<DailyPayload> = {
  id: "blachy.daily",
  description: "Procedura Blach: maile na listę (otwarcie/przypomnienie/zamknięcie), zestawienie dla Kapituły, sprzątanie po ogłoszeniu.",
  validate: () => undefined,
  run: async (payload, ctx) => {
    const today = str(payload?.today) || todayWarsawIso();
    const bctx = await loadBlachyContext(ctx.firestore, today);
    const {cfg} = bctx;
    if (!cfg.wlaczona) return {ok: true, message: "Procedura wyłączona (blachy_procedura)"};
    const ref = stateRef(ctx.firestore, cfg.rok);
    const st = (await ref.get()).data() as any || {};
    const done: string[] = [];
    const send = async (to: string, m: {subject: string; text: string; html: string}) => {
      if (!ctx.dryRun) await ctx.workspace.sendGenericEmailHtml(to, m.subject, m.text, m.html);
    };
    const mark = async (field: string) => {
      if (!ctx.dryRun) await ref.set({[field]: ts()}, {merge: true});
      done.push(field);
    };

    if (today >= cfg.nominacjeOd && today <= cfg.nominacjeDo && !st.mailOtwarcieAt) {
      await send(bctx.listaEmail, mailOtwarcie(cfg, bctx.appUrl, bctx.regulaminUrl));
      await mark("mailOtwarcieAt");
    }
    if (today > cfg.nominacjeOd && today >= dzienPrzypomnienia(cfg) && today <= cfg.nominacjeDo && !st.mailPrzypomnienieAt) {
      await send(bctx.listaEmail, mailPrzypomnienie(cfg, bctx.appUrl));
      await mark("mailPrzypomnienieAt");
    }
    if (today > cfg.nominacjeDo && !st.zestawienieAt) {
      if (!ctx.dryRun) await compileKandydatury(ctx.firestore, cfg.rok);
      const items = await buildDossier(ctx.firestore, cfg.rok);
      const m = mailDossier(cfg, items, bctx.appUrl);
      for (const e of kapitulaEmails(cfg)) await send(e, m);
      await send(bctx.listaEmail, mailZamkniecie(cfg));
      await mark("zestawienieAt");
    }
    if (st.ogloszenieAt?.toDate && !st.usunietoAt) {
      const ogl = st.ogloszenieAt.toDate().toLocaleDateString("en-CA", {timeZone: "Europe/Warsaw"});
      if (minusDays(today, DNI_DO_USUNIECIA) >= ogl) {
        if (!ctx.dryRun) await purgeRok(ctx.firestore, cfg.rok);
        await mark("usunietoAt");
      }
    }
    return {ok: true, message: `Blachy ${cfg.rok}: ${done.length ? done.join(", ") : "nic do zrobienia"}${ctx.dryRun ? " (dry)" : ""}`, details: {done}};
  },
};

/** Mail potwierdzający do zgłaszającego (§3). */
export const blachyNominacjaMailTask: ServiceTask<{id: string}> = {
  id: "blachy.nominacjaMail",
  description: "Potwierdzenie przyjęcia zgłoszenia kandydata do Blachy (mail do zgłaszającego).",
  validate: (p) => {
    if (!str(p?.id)) throw new Error("payload.id wymagany");
  },
  run: async (payload, ctx) => {
    const s = await ctx.firestore.collection(NOMINACJE_COLLECTION).doc(payload.id).get();
    const n = s.data() as any;
    if (!s.exists || !n.autorEmail || n.mailAt) return {ok: true, message: "Pominięte"};
    const bctx = await loadBlachyContext(ctx.firestore, todayWarsawIso());
    const m = mailNominacjaPotwierdzenie(n.rok, kandydatLabel(n.kandydat || {}), bctx.cfg.nominacjeDo);
    await ctx.workspace.sendGenericEmailHtml(n.autorEmail, m.subject, m.text, m.html);
    await s.ref.update({mailAt: ts()});
    return {ok: true, message: "Wysłane"};
  },
};

/** Po zatwierdzeniu przez Zarząd: prośba do wyróżnionych o potwierdzenie przyjęcia (§5 pkt 12). */
export const blachyRequestAcceptanceTask: ServiceTask<{rok: number}> = {
  id: "blachy.requestAcceptance",
  description: "Maile do wyróżnionych z prośbą o potwierdzenie przyjęcia Blachy.",
  validate: (p) => {
    if (!Number(p?.rok)) throw new Error("payload.rok wymagany");
  },
  run: async (payload, ctx) => {
    const bctx = await loadBlachyContext(ctx.firestore, todayWarsawIso());
    const base = `${bctx.appUrl.replace(/\/$/, "")}/api/blachy/przyjecie`;
    const kands = (await listKandydatury(ctx.firestore, Number(payload.rok))).filter((k) => k.decyzja === "wybrany" && !k.przyjecie);
    const out: string[] = [];
    for (const k of kands) {
      const mail = str(k.kandydat?.email);
      if (!mail) {
        await k.ref.update({przyjecie: {status: "brak_maila"}});
        out.push(`${k.label}: brak e-maila — Zarząd potwierdza ręcznie`);
        continue;
      }
      const token = acceptanceToken();
      await k.ref.update({przyjecie: {status: "oczekuje", token, wyslanoAt: ts()}});
      const m = mailPrzyjecie(payload.rok, str(k.label), `${base}?t=${token}&d=tak`, `${base}?t=${token}&d=nie`);
      await ctx.workspace.sendGenericEmailHtml(mail, m.subject, m.text, m.html);
      out.push(`${k.label}: wysłano`);
    }
    return {ok: true, message: `Prośby o przyjęcie: ${out.length}`, details: {out}};
  },
};

/**
 * Ogłoszenie (§6 pkt 2, 4): wpis przyjętych do Rejestru (kolejne numery od 42), mail na listę
 * (liczba rozpatrzonych, wyróżnieni, uzasadnienia), mail do każdego zgłaszającego, protokół w stanie roku.
 */
export const blachyAnnounceTask: ServiceTask<{rok: number}> = {
  id: "blachy.announce",
  description: "Ogłoszenie wyników procedury Blach: Rejestr, lista dyskusyjna, informacja dla zgłaszających.",
  validate: (p) => {
    if (!Number(p?.rok)) throw new Error("payload.rok wymagany");
  },
  run: async (payload, ctx) => {
    const db = ctx.firestore;
    const rok = Number(payload.rok);
    const sRef = stateRef(db, rok);
    const st = (await sRef.get()).data() as any || {};
    if (st.ogloszenieAt) return {ok: true, message: "Już ogłoszone"};
    const bctx = await loadBlachyContext(db, todayWarsawIso());
    const kands = (await listKandydatury(db, rok)).filter((k) => k.status !== "nieprawidlowa");
    const wybrani = kands.filter((k) => k.decyzja === "wybrany" && k.przyjecie?.status === "przyjeta");

    const reg = await db.collection(BLACHY_COLLECTION).get();
    const nrs = reg.docs.map((d) => (d.data() as any).nr);
    const laureaci = [];
    for (const k of wybrani) {
      const nr = nextNumer(nrs);
      nrs.push(nr);
      const kd = k.kandydat || {};
      await db.collection(BLACHY_COLLECTION).doc(`p${rok}_${k.key}`).set({
        imie: str(kd.imie), nazwisko: str(kd.nazwisko), ksywa: str(kd.ksywa), rok, nr,
        uzasadnienie: str(k.uzasadnienieKapituly), klub: str(kd.klub), zalozycielska: "", sp: false,
        email: str(kd.email), memberId: null, zrodlo: "procedura", createdAt: ts(), updatedAt: ts(), updatedBy: "blachy.announce",
      });
      laureaci.push({label: str(k.label), uzasadnienie: str(k.uzasadnienieKapituly), nr});
    }

    const m = mailOgloszenie(rok, kands.length, laureaci, bctx.appUrl);
    await ctx.workspace.sendGenericEmailHtml(bctx.listaEmail, m.subject, m.text, m.html);

    const autorzy = new Map<string, Set<string>>();
    for (const k of kands) {
      for (const id of (k.nominacjeIds || [])) {
        const n = (await db.collection(NOMINACJE_COLLECTION).doc(id).get()).data() as any;
        if (!n?.autorEmail) continue;
        if (!autorzy.has(n.autorEmail)) autorzy.set(n.autorEmail, new Set());
        autorzy.get(n.autorEmail)?.add(str(k.label));
      }
    }
    for (const [mail, labels] of autorzy) {
      for (const l of labels) {
        const r = mailRozpatrzona(rok, l);
        await ctx.workspace.sendGenericEmailHtml(mail, r.subject, r.text, r.html);
      }
    }

    await sRef.set({
      ogloszenieAt: ts(),
      protokol: {
        rozpatrzone: kands.length,
        odroczone: kands.filter((k) => k.status === "odroczone").length,
        wybrani: kands.filter((k) => k.decyzja === "wybrany").map((k) => ({label: k.label, wynik: k.wynik, uzasadnienie: k.uzasadnienieKapituly, przyjecie: k.przyjecie?.status || null})),
        uchwala: st.zatwierdzenie?.uchwala || "",
      },
    }, {merge: true});
    return {ok: true, message: `Ogłoszono: ${laureaci.length} blach, rozpatrzonych ${kands.length}`, details: {laureaci}};
  },
};
