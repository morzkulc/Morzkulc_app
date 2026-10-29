/* eslint-disable require-jsdoc */
import type {Request, Response} from "express";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import {
  ZGLOSZENIA_COLLECTION, validateZgloszenie, zgloszenieDocId,
  DOSWIADCZENIE, PLYWANIE, SCHORZENIA, ZAINTERESOWANIA, SKAD,
} from "../modules/kurs/kurs_zgloszenia";
import {loadKursSignupConfig, przelewInfo, zapisyOtwarte, demoActive, KursSignupConfig} from "../modules/kurs/kurs_signup_config";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; email_verified?: boolean}};

export type KursZgloszenieDeps = {
  db: FirebaseFirestore.Firestore;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
};

/**
 * Strona kursu (kurs.morzkulc.pl) woła API aplikacji cross-origin z tokenem Google.
 * Własna lista originów zamiast globalnej ALLOWED_ORIGINS (ta zostaje dla aplikacji);
 * odpowiedzi są per użytkownik, więc no-store i Vary: Origin.
 */
export const KURS_ORIGINS = ["https://kurs.morzkulc.pl", "https://morzkulc-kurs.web.app"];

function cors(req: Request, res: Response): boolean {
  const origin = String(req.headers.origin || "");
  if (!KURS_ORIGINS.includes(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  return true;
}

function kursPublic(cfg: KursSignupConfig) {
  const k = cfg.kurs;
  return {
    edycja: k.edycja ?? "",
    zapisyStatus: k.zapisyStatus ?? "",
    zapisyOtwarte: zapisyOtwarte(cfg),
    demo: demoActive(cfg, new Date().toISOString().slice(0, 10)),
    demoDo: k.zapisyDemoDo ?? "",
    cena: k.cena ?? null,
    zadatek: k.zadatek ?? null,
    terminDoplaty: k.terminDoplaty ?? "",
  };
}

// Odpowiedzi wyboru formularza — jedno źródło z walidacją serwera (strona ich nie powiela).
const OPCJE = {doswiadczenie: DOSWIADCZENIE, plywanie: PLYWANIE, schorzenia: SCHORZENIA, zainteresowania: ZAINTERESOWANIA, skad: SKAD};

/**
 * Kto nie może zgłosić się przez formularz:
 *  - w trybie demo — każdy, kto ma konto w aplikacji (testy nie mogą zmieniać ról
 *    prawdziwych użytkowników; przeniesienie nadpisałoby rolę w arkuszu członków),
 *  - w prawdziwych zapisach — konto z rolą inną niż sympatyk (członek, kandydat,
 *    zarząd, KR, kursant): formularz jest dla nowych osób i sympatyków.
 * Zwraca komunikat blokady albo "".
 */
async function accountBlock(db: FirebaseFirestore.Firestore, email: string, demo: boolean): Promise<string> {
  const q = await db.collection("users_active").where("email", "==", email).limit(1).get();
  if (q.empty) return "";
  if (demo) {
    return "W trybie testowym zgłoszenie można wysłać tylko z konta Google, które NIE jest zarejestrowane " +
      "w aplikacji klubowej. Zaloguj się innym kontem.";
  }
  const role = String((q.docs[0].data() as any)?.role_key || "");
  if (role === "rola_sympatyk") return "";
  return "Masz już konto w aplikacji klubowej z rolą, która nie pozwala zapisać się na kurs przez formularz. " +
    "Jeśli chcesz wziąć udział w kursie, napisz do nas.";
}

function view(cfg: KursSignupConfig, z: any) {
  if (!z) return null;
  return {
    status: z.status,
    demo: z.demo === true,
    createdAt: z.createdAt?.toDate ? z.createdAt.toDate().toISOString() : null,
    imie: z.form?.imie || "",
    nazwisko: z.form?.nazwisko || "",
    student: z.form?.student === true,
    przelew: przelewInfo(cfg, z),
  };
}

/**
 * GET  /api/kurs/zgloszenie — stan kursu + zgłoszenie zalogowanego (lub null) z danymi do przelewu.
 * POST /api/kurs/zgloszenie — nowe zgłoszenie (formularz), tylko przy zapisach otwartych/rezerwowych.
 * Klucz: e-mail z tokenu Google (zweryfikowany) — ten sam posłuży później w aplikacji.
 */
export async function handleKursZgloszenie(req: Request, res: Response, deps: KursZgloszenieDeps) {
  const {db} = deps;
  const corsOk = cors(req, res);
  if (req.method === "OPTIONS") {
    res.status(corsOk ? 204 : 403).send("");
    return;
  }
  if (!corsOk) {
    res.status(403).json({ok: false, code: "origin_not_allowed"});
    return;
  }
  if (!deps.requireAllowedHost(req, res)) return;
  res.setHeader("Cache-Control", "no-store");

  try {
    if (req.method !== "GET" && req.method !== "POST") {
      res.status(405).json({ok: false, code: "method_not_allowed"});
      return;
    }
    const tokenCheck = await deps.requireIdToken(req);
    if ("error" in tokenCheck) {
      res.status(401).json({ok: false, code: "unauthorized", message: tokenCheck.error});
      return;
    }
    const email = String(tokenCheck.decoded.email || "").trim().toLowerCase();
    if (!email || tokenCheck.decoded.email_verified === false) {
      res.status(403).json({ok: false, code: "email_unverified", message: "Konto Google bez potwierdzonego adresu e-mail."});
      return;
    }

    const cfg = await loadKursSignupConfig(db);
    const edycja = String(cfg.kurs.edycja || "");
    if (!edycja) {
      res.status(503).json({ok: false, code: "kurs_not_configured", message: "Zapisy nie są jeszcze skonfigurowane."});
      return;
    }
    const ref = db.collection(ZGLOSZENIA_COLLECTION).doc(zgloszenieDocId(edycja, email));
    const snap = await ref.get();
    const existing = snap.exists ? snap.data() : null;

    const demo = demoActive(cfg, new Date().toISOString().slice(0, 10));
    const blokada = existing ? "" : await accountBlock(db, email, demo);

    if (req.method === "GET") {
      res.status(200).json({ok: true, email, kurs: kursPublic(cfg), opcje: OPCJE, blokada, zgloszenie: view(cfg, existing)});
      return;
    }

    if (existing) {
      res.status(409).json({ok: false, code: "already_submitted", message: "Masz już zgłoszenie na ten kurs.",
        zgloszenie: view(cfg, existing)});
      return;
    }
    if (!zapisyOtwarte(cfg)) {
      res.status(409).json({ok: false, code: "zapisy_closed", message: "Zapisy są obecnie zamknięte."});
      return;
    }
    if (blokada) {
      res.status(409).json({ok: false, code: "account_blocked", message: blokada});
      return;
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    const v = validateZgloszenie(req.body || {}, todayIso);
    if (!v.ok) {
      res.status(400).json({ok: false, code: "validation_failed", fields: v.fields});
      return;
    }

    const doc = {
      edycja,
      email,
      uid: tokenCheck.decoded.uid,
      form: v.data,
      status: "nowe",
      demo: demoActive(cfg, todayIso),
      listaPrzyZgloszeniu: cfg.kurs.zapisyStatus,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    try {
      await ref.create(doc);
    } catch (e: any) {
      // Wyścig dwóch wysłań — drugie dostaje to samo co przy istniejącym zgłoszeniu.
      if (e?.code === 6 || /already exists/i.test(String(e?.message))) {
        res.status(409).json({ok: false, code: "already_submitted", message: "Masz już zgłoszenie na ten kurs."});
        return;
      }
      throw e;
    }

    const jobRef = db.collection("service_jobs").doc();
    await jobRef.set({
      id: jobRef.id, taskId: "kurs.notifyZgloszenie", payload: {id: ref.id}, status: "queued", attempts: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    logger.info("kursZgloszenie: created", {id: ref.id});
    res.status(200).json({ok: true, email, kurs: kursPublic(cfg),
      zgloszenie: view(cfg, {...doc, createdAt: null})});
  } catch (err: any) {
    logger.error("kursZgloszenie failed", {message: err?.message, stack: err?.stack});
    res.status(500).json({ok: false, code: "server_error", message: "Błąd serwera. Spróbuj ponownie za chwilę."});
  }
}
