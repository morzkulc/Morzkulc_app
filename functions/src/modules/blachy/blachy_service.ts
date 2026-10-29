/**
 * Operacje procedury Blach na Firestore — wspólne dla endpointu /api/blachy/* i tasków blachy.*.
 */
import * as admin from "firebase-admin";
import * as crypto from "crypto";
import {getServiceConfig} from "../../service/service_config";
import {
  BlachyConfig, KANDYDATURY_COLLECTION, NOMINACJE_COLLECTION, PROCEDURA_COLLECTION, PROG_WYBORU, SEATS,
  candidateKey, kandydatLabel, parseBlachyConfig, seatVoters,
} from "./blachy_procedura";
import {DossierItem} from "./blachy_mail";

const str = (v: any) => String(v == null ? "" : v).trim();
const ts = () => admin.firestore.FieldValue.serverTimestamp();

export type BlachyContext = {cfg: BlachyConfig; appUrl: string; regulaminUrl: string; listaEmail: string; vars: Record<string, any>};

export async function loadBlachyContext(db: FirebaseFirestore.Firestore, todayIso: string): Promise<BlachyContext> {
  const snap = await db.collection("setup").doc("vars_members").get();
  const vars = ((snap.data() as any)?.vars || {}) as Record<string, any>;
  return {
    cfg: parseBlachyConfig(vars, todayIso),
    appUrl: str(vars?.link_aplikacji?.value) || "https://app.morzkulc.pl/",
    regulaminUrl: str(vars?.regulaminy?.value) || str(vars?.regulamin_url?.value),
    listaEmail: getServiceConfig().listaGroupEmail,
    vars,
  };
}

export function stateRef(db: FirebaseFirestore.Firestore, rok: number) {
  return db.collection(PROCEDURA_COLLECTION).doc(String(rok));
}

export function userName(u: any): string {
  const p = u?.profile || {};
  const full = [str(p.firstName), str(p.lastName)].filter(Boolean).join(" ");
  const nick = str(p.nickname);
  return full ? (nick ? `${full} „${nick}”` : full) : (nick || str(u?.email) || str(u?.displayName));
}

/**
 * Zbiera zgłoszenia roku w kandydatury (jedna na osobę, §3 pkt 3). Idempotentne: dokłada tylko
 * zgłoszenia jeszcze nieprzypisane; istniejące kandydatury (po weryfikacji/głosowaniu) zostają.
 */
export async function compileKandydatury(db: FirebaseFirestore.Firestore, rok: number): Promise<number> {
  const noms = await db.collection(NOMINACJE_COLLECTION).where("rok", "==", rok).get();
  let added = 0;
  for (const d of noms.docs) {
    const n = d.data() as any;
    if (n.status !== "zlozona" || n.kandydaturaId) continue;
    const key = str(n.candidateKey) || candidateKey(n.kandydat || {});
    const id = `${rok}_${key}`;
    const ref = db.collection(KANDYDATURY_COLLECTION).doc(id);
    const ex = await ref.get();
    if (ex.exists) {
      const ids: string[] = ((ex.data() as any)?.nominacjeIds || []);
      await ref.update({nominacjeIds: [...ids, d.id], updatedAt: ts()});
    } else {
      await ref.set({
        rok, key, kandydat: n.kandydat || {}, label: kandydatLabel(n.kandydat || {}),
        nominacjeIds: [d.id], status: "do_weryfikacji", wylaczeni: [], glosujacy: {}, oddali: [],
        decyzja: null, wynik: null, uzasadnienieKapituly: "", przyjecie: null,
        createdAt: ts(), updatedAt: ts(),
      });
    }
    await d.ref.update({kandydaturaId: id});
    added++;
  }
  return added;
}

export async function listKandydatury(db: FirebaseFirestore.Firestore, rok: number) {
  const s = await db.collection(KANDYDATURY_COLLECTION).where("rok", "==", rok).get();
  return s.docs.map((d) => ({id: d.id, ref: d.ref, ...(d.data() as any)}))
    .sort((a, b) => str(a.label).localeCompare(str(b.label), "pl"));
}

/** Treść do zestawienia dla Kapituły (bez kandydatur odrzuconych jako nieprawidłowe). */
export async function buildDossier(db: FirebaseFirestore.Firestore, rok: number): Promise<DossierItem[]> {
  const kands = (await listKandydatury(db, rok)).filter((k) => k.status !== "nieprawidlowa");
  const out: DossierItem[] = [];
  for (const k of kands) {
    const noms = await Promise.all((k.nominacjeIds || []).map((id: string) => db.collection(NOMINACJE_COLLECTION).doc(id).get()));
    out.push({
      label: str(k.label),
      spozaKlubu: !str(k.kandydat?.uid),
      nominacje: noms.filter((s) => s.exists).map((s) => {
        const n = s.data() as any;
        return {autor: str(n.autorName) || str(n.autorEmail), obszary: n.obszary || [], zaslugi: str(n.zaslugi), uzasadnienie: str(n.uzasadnienie)};
      }),
    });
  }
  return out;
}

/** Otwarcie głosowania: zamraża uprawnionych na miejscach; brak 5 bezstronnych osób → „odroczone" (§5 pkt 3). */
export async function openVoting(db: FirebaseFirestore.Firestore, cfg: BlachyConfig, kandId: string): Promise<"otwarte" | "odroczone"> {
  const ref = db.collection(KANDYDATURY_COLLECTION).doc(kandId);
  return db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const k = s.data() as any;
    if (!s.exists || k.status !== "do_weryfikacji") throw httpError(409, "Głosowanie można otworzyć tylko dla kandydatury w weryfikacji");
    const seats = seatVoters(cfg, k.wylaczeni || []);
    if (seats.some((x) => !x.email)) {
      tx.update(ref, {status: "odroczone", updatedAt: ts()});
      return "odroczone";
    }
    const glosujacy: Record<string, string> = {};
    for (const x of seats) glosujacy[String(x.seat)] = x.email as string;
    tx.update(ref, {status: "otwarte", glosujacy, oddali: [], updatedAt: ts()});
    tx.set(ref.collection("tajne").doc("wynik"), {tak: 0, nie: 0});
    return "otwarte";
  });
}

/**
 * Tajny głos (§5 pkt 3). W jednej transakcji: dopisanie NUMERU MIEJSCA do „oddali" (jawne — kworum)
 * i zwiększenie sumy TAK/NIE w osobnym dokumencie. Nie powstaje żaden zapis łączący osobę z głosem.
 * Po 5 głosach: decyzja (TAK ≥ 4 → wybrany) i sumy przepisane do kandydatury.
 */
export async function castVote(db: FirebaseFirestore.Firestore, kandId: string, voterEmail: string, glos: "tak" | "nie") {
  const ref = db.collection(KANDYDATURY_COLLECTION).doc(kandId);
  const tallyRef = ref.collection("tajne").doc("wynik");
  return db.runTransaction(async (tx) => {
    const [s, t] = await Promise.all([tx.get(ref), tx.get(tallyRef)]);
    const k = s.data() as any;
    if (!s.exists || k.status !== "otwarte") throw httpError(409, "Głosowanie nie jest otwarte");
    const seat = Object.entries(k.glosujacy || {}).find(([, e]) => str(e) === str(voterEmail).toLowerCase())?.[0];
    if (!seat) throw httpError(403, "Nie głosujesz w tej sprawie");
    const oddali: string[] = k.oddali || [];
    if (oddali.includes(seat)) throw httpError(409, "Głos już oddany");
    const tally = {tak: Number((t.data() as any)?.tak || 0), nie: Number((t.data() as any)?.nie || 0)};
    tally[glos] += 1;
    const nextOddali = [...oddali, seat];
    tx.set(tallyRef, tally);
    if (nextOddali.length >= SEATS) {
      tx.update(ref, {oddali: nextOddali, status: "zakonczone", wynik: tally,
        decyzja: tally.tak >= PROG_WYBORU ? "wybrany" : "niewybrany", updatedAt: ts()});
    } else {
      tx.update(ref, {oddali: nextOddali, updatedAt: ts()});
    }
    return {oddane: nextOddali.length};
  });
}

/** Ponowne rozpatrzenie po zwrocie przez Zarząd (§5 pkt 5): czyści głosowanie i decyzję. */
export async function resetKandydatura(db: FirebaseFirestore.Firestore, kandId: string) {
  const ref = db.collection(KANDYDATURY_COLLECTION).doc(kandId);
  await ref.collection("tajne").doc("wynik").delete();
  await ref.update({status: "do_weryfikacji", glosujacy: {}, oddali: [], wynik: null, decyzja: null, przyjecie: null, updatedAt: ts()});
}

/** §6 pkt 2: po terminie na zastrzeżenia usuwamy nominacje, kandydatury i sumy; zostają wyróżnieni (Rejestr + protokół). */
export async function purgeRok(db: FirebaseFirestore.Firestore, rok: number): Promise<{nominacje: number; kandydatury: number}> {
  const noms = await db.collection(NOMINACJE_COLLECTION).where("rok", "==", rok).get();
  for (const d of noms.docs) await d.ref.delete();
  const kands = await db.collection(KANDYDATURY_COLLECTION).where("rok", "==", rok).get();
  for (const d of kands.docs) {
    await d.ref.collection("tajne").doc("wynik").delete();
    await d.ref.delete();
  }
  return {nominacje: noms.size, kandydatury: kands.size};
}

/** Token linku „Przyjmuję / Nie przyjmuję" w mailu do wyróżnionego (48 znaków hex). */
export function acceptanceToken(): string {
  return crypto.randomBytes(24).toString("hex");
}

export function httpError(status: number, message: string): Error & {status: number} {
  const e = new Error(message) as Error & {status: number};
  e.status = status;
  return e;
}

export function enqueueJob(db: FirebaseFirestore.Firestore, taskId: string, payload: Record<string, any>) {
  const ref = db.collection("service_jobs").doc();
  return ref.set({
    id: ref.id, taskId, payload, status: "queued", attempts: 0,
    createdAt: ts(), updatedAt: ts(), nextRunAt: admin.firestore.Timestamp.now(),
  });
}
