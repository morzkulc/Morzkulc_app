/* eslint-disable require-jsdoc */
/* eslint-disable valid-jsdoc */

// MUSI być pierwszym importem — mierzy koszt załadowania całej reszty grafu
// modułów (patrz service/boot_timer.ts). Sam nie ładuje niczego.
import {getModuleEvalMs, markModuleEvalDone} from "./service/boot_timer";

import {onRequest} from "firebase-functions/v2/https";
import {setGlobalOptions} from "firebase-functions/v2/options";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import cors from "cors";
import type {Request, Response} from "express";

import {handleRegisterUser} from "./api/registerUserHandler";
import {handleCheckNicknameAvailability} from "./api/checkNicknameAvailabilityHandler";
import {handleGetGearKayaks} from "./api/getGearKayaksHandler";
import {handleGetGearItems} from "./api/getGearItemsHandler";
import {handleGearMyReservations} from "./api/gearMyReservationsHandler";
import {handleGearReservationCreate} from "./api/gearReservationCreateHandler";
import {handleGearBundleReservationCreate} from "./api/gearBundleReservationCreateHandler";
import {handleGearBundleReservationUpdateItems} from "./api/gearBundleReservationUpdateItemsHandler";
import {handleGetGearItemAvailability} from "./api/getGearItemAvailabilityHandler";
import {handleGearReservationUpdate} from "./api/gearReservationUpdateHandler";
import {handleGearReservationCancel} from "./api/gearReservationCancelHandler";
import {handleAdminGearReservationCancel} from "./api/adminGearReservationCancelHandler";
import {handleGetGearFavorites} from "./api/getGearFavoritesHandler";
import {handleGearFavoriteToggle} from "./api/gearFavoriteToggleHandler";
import {handleGetGodzinki} from "./api/getGodzinkiHandler";
import {handleSubmitGodzinki} from "./api/submitGodzinkiHandler";
import {handleGodzinkiPurchase} from "./api/godzinkiPurchaseHandler";
import {handleGetKayakReservations} from "./api/getKayakReservationsHandler";
import {handleGetEvents} from "./api/getEventsHandler";
import {handleGetAdminPending} from "./api/getAdminPendingHandler";
import {handleGetAdminGearRentals} from "./api/getAdminGearRentalsHandler";
import {handleGetAdminGearTopRentals} from "./api/getAdminGearTopRentalsHandler";
import {handleGetAdminGearDamageReports} from "./api/getAdminGearDamageReportsHandler";
import {handleGetAdminMemberActivity} from "./api/getAdminMemberActivityHandler";
import {handleGetAdminMemberDues} from "./api/getAdminMemberDuesHandler";
import {handleGetAdminUserActivity} from "./api/getAdminUserActivityHandler";
import {handleAdminEventsSyncCalendar} from "./api/adminEventsSyncCalendarHandler";
import {handleAdminApprove, handleAdminReject} from "./api/adminApprovalHandler";
import {handleSubmitGearDamageReport} from "./api/submitGearDamageReportHandler";
import {handleResolveGearDamageReport} from "./api/resolveGearDamageReportHandler";
import {handleSubmitEvent} from "./api/submitEventHandler";
import {handleGetBasenSessions} from "./api/getBasenSessionsHandler";
import {handleBasenOrder} from "./api/basenOrderHandler";
import {handleBasenEnroll} from "./api/basenEnrollHandler";
import {handleBasenCancelEnrollment} from "./api/basenCancelEnrollmentHandler";
import {handleBasenCreateSession} from "./api/basenCreateSessionHandler";
import {handleBasenCancelSession} from "./api/basenCancelSessionHandler";
import {handleBasenSetKayak} from "./api/basenSetKayakHandler";
import {handleBasenSetInstructor} from "./api/basenSetInstructorHandler";
import {handleBasenClaimWaitingStudent} from "./api/basenClaimWaitingStudentHandler";
import {handleBasenAddSauna} from "./api/basenAddSaunaHandler";
import {handleGetBasenAdminGodzinyUsers} from "./api/getBasenAdminGodzinyUsersHandler";
import {handleGetBasenAdminGodzinyHistory} from "./api/getBasenAdminGodzinyHistoryHandler";
import {handleGetBasenMyGodziny} from "./api/getBasenMyGodzinyHandler";
import {handleBasenAdminAddGodziny} from "./api/basenAdminAddGodzinyHandler";
import {handleKmAddLog} from "./api/kmAddLogHandler";
import {handleKmMyLogs} from "./api/kmMyLogsHandler";
import {handleKmMyStats} from "./api/kmMyStatsHandler";
import {handleKmRankings} from "./api/kmRankingsHandler";
import {handleKmPlaces} from "./api/kmPlacesHandler";
import {handleKmEventStats} from "./api/kmEventStatsHandler";
import {handleKmMapData} from "./api/kmMapDataHandler";
import {handleKmAdminMergePlaces} from "./api/kmAdminMergePlacesHandler";
import {handleGetKursInfo} from "./api/getKursInfoHandler";
import {handleGetKursantStats} from "./api/getKursantStatsHandler";
import {handleGetKlubInfo} from "./api/getKlubInfoHandler";
import {handleGetPublicSite} from "./api/getPublicSiteHandler";
import {handleKursZgloszenie} from "./api/kursZgloszenieHandler";
import {handleAdminKursZgloszenia, handleAdminKursZgloszenieAction} from "./api/adminKursZgloszeniaHandler";
import {handleAdminBlachy} from "./api/adminBlachyHandler";
import {handleBlachyApi} from "./api/blachyApiHandler";
import {handleUserWeight} from "./api/userWeightHandler";
import {handleNotificationPrefs} from "./api/notificationPrefsHandler";
import {handleProfileData} from "./api/profileDataHandler";
import {getAppVars} from "./modules/setup/app_vars";
import {handleDues} from "./api/duesHandler";
import {handleAdminDues} from "./api/adminDuesHandler";
import {handleTestAccountRole} from "./api/testAccountRoleHandler";
import {handleEventInterestToggle} from "./api/eventInterestToggleHandler";
import {handleGetEventInterests} from "./api/getEventInterestsHandler";
import {getServiceConfig} from "./service/service_config";
import {parseSchoolYear, getKursWypozyczaFlag, getKursWindowEndSuffix} from "./modules/equipment/bundle/gear_bundle_service";

setGlobalOptions({region: "us-central1"});

admin.initializeApp();
const db = admin.firestore();
db.settings({ignoreUndefinedProperties: true});
// Bucket Storage tworzony dopiero w submitGearDamageReport — admin.storage() na
// poziomie modułu ładował @google-cloud/storage (147 modułów, ~90 ms lokalnie) przy
// zimnym starcie KAŻDEJ z funkcji, choć używa go tylko zgłoszenie uszkodzenia.

const svcCfg = getServiceConfig();
const {adminRoleKeys, memberRoleKeys} = svcCfg;

const ALLOWED_HOSTS = new Set<string>([
  "morzkulc-e9df7.web.app",
  "morzkulc-e9df7.firebaseapp.com",
  "app.morzkulc.pl",
  "sprzet-skk-morzkulc.web.app",
  "sprzet-skk-morzkulc.firebaseapp.com",
  "localhost",
  "127.0.0.1",
]);

const ALLOWED_ORIGINS = new Set<string>([
  "https://morzkulc-e9df7.web.app",
  "https://morzkulc-e9df7.firebaseapp.com",
  "https://app.morzkulc.pl",
  "https://sprzet-skk-morzkulc.web.app",
  "https://sprzet-skk-morzkulc.firebaseapp.com",
  "http://localhost:5000",
  "http://localhost:5173",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:5173",
]);

function normalizeHost(raw: unknown): string {
  const s = String(raw || "").trim().toLowerCase();
  const first = s.split(",")[0].trim();
  return first.replace(/:\d+$/, "");
}

function getRequestHost(req: Request): string {
  const xfHost = req.headers["x-forwarded-host"];
  const host = xfHost ?? req.headers.host ?? "";
  return normalizeHost(host);
}

function normalizeOrigin(raw: unknown): string {
  return String(raw || "").trim();
}

function getRequestOrigin(req: Request): string {
  return normalizeOrigin(req.headers.origin);
}

function isAllowedHost(reqHost: string): boolean {
  if (!reqHost) return false;
  return ALLOWED_HOSTS.has(reqHost);
}

// ── Server-Timing: pomiar czasu handlera i kosztu zimnego startu ─────────────
// Wpinamy się w setCorsHeaders, bo to JEDYNA funkcja wołana dokładnie raz przez
// każdy z 65 endpointów (bezpośrednio w index.ts albo przez deps.setCorsHeaders
// w plikach api/*.ts) — dzięki temu instrumentacja nie wymaga dotykania żadnego
// handlera z osobna.
//
// Po co: bez rozbicia `ms = net + cold + app` po stronie klienta każda poprawka
// rzędu 50 ms tonie w wahaniach zimnego startu (rząd sekund) i nie da się
// uczciwie powiedzieć, czy cokolwiek przyspieszyło.
//
// cold;dur = process.uptime() przy PIERWSZYM żądaniu obsłużonym przez instancję,
// czyli czas od startu procesu Node (w tym ~1,4 s na require całego lib/index.js).
// To dolna granica pełnego kosztu zimnego startu — nie obejmuje schedulingu
// Cloud Run i pobrania obrazu sprzed startu procesu (ta część jest widoczna po
// stronie klienta jako `net`). Dla ciepłej instancji zawsze 0.
let instanceWarm = false;

function attachServerTiming(req: Request, res: Response) {
  const r = res as any;
  if (r.__stAttached) return; // OPTIONS przechodzi przez sendPreflight → setCorsHeaders
  r.__stAttached = true;

  const t0 = process.hrtime.bigint();
  const coldMs = instanceWarm ? 0 : Math.round(process.uptime() * 1000);
  const bootMs = getModuleEvalMs();
  if (!instanceWarm) {
    instanceWarm = true;
    // DOKŁADNIE JEDNA linia na cykl życia instancji (nie na żądanie) — pozwala
    // policzyć zimne starty zapytaniem do logów, czego dziś nie da się zrobić.
    logger.info("coldstart", {fn: process.env.K_SERVICE || "", ms: coldMs, bootMs});
  }

  // Nagłówek musi powstać tuż przed wypchnięciem nagłówków, bo w momencie
  // wywołania setCorsHeaders czas handlera jeszcze nie istnieje. Technika jak
  // w pakiecie `on-headers`, bez dokładania zależności.
  const origWriteHead = res.writeHead.bind(res);
  (res as any).writeHead = function(...args: any[]) {
    try {
      if (!res.headersSent) {
        const appMs = Number(process.hrtime.bigint() - t0) / 1e6;
        res.setHeader("Server-Timing", `app;dur=${appMs.toFixed(1)}, cold;dur=${coldMs}, boot;dur=${bootMs}`);
      }
    } catch {
      // Telemetria nigdy nie może wywrócić odpowiedzi.
    }
    return (origWriteHead as any)(...args);
  };
}

function setCorsHeaders(req: Request, res: Response) {
  attachServerTiming(req, res);
  const origin = getRequestOrigin(req);
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function deny(res: Response, status: number, message: string) {
  res.status(status).json({error: message});
}

function requireAllowedHost(req: Request, res: Response): boolean {
  const reqHost = getRequestHost(req);

  if (!isAllowedHost(reqHost)) {
    logger.warn("Blocked request by host allowlist", {
      reqHost,
      origin: getRequestOrigin(req),
      path: req.path,
      method: req.method,
    });
    deny(res, 403, "Forbidden (host not allowed)");
    return false;
  }
  return true;
}

function sendPreflight(req: Request, res: Response): boolean {
  if (req.method !== "OPTIONS") return false;

  if (!requireAllowedHost(req, res)) return true;

  setCorsHeaders(req, res);

  const origin = getRequestOrigin(req);
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    deny(res, 403, "Forbidden (origin not allowed)");
    return true;
  }

  res.status(204).send("");
  return true;
}

const corsHandler = cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

// ====== NEW SINGLE SETUP SHAPE (ONLY) ======
type ModuleAccess = {
  mode?: "off" | "prod" | "test";
  rolesAllowed?: string[];
  testUsersAllow?: string[];
  usersBlock?: string[];
  testUserGranted?: boolean; // set server-side when testUsersAllow overrides disabled/off state
};

type SetupModuleConfig = {
  label?: string;
  type?: string; // e.g. "gear" | "godzinki" | "imprezy" | "basen" — used by frontend to resolve component
  defaultRoute?: string;
  order?: number;
  enabled?: boolean;
  access?: ModuleAccess;
};

type StatusMapping = {
  label: string;
  blocksAccess?: boolean;
};

type RoleMapping = {
  label: string;
  groups?: string[]; // Google Group email addresses for users with this role
};

type SetupDefaults = {
  newUserRoleCode?: string;
  newUserStatusCode?: string;
  openingBalanceMemberField?: string;
  openingBalanceMemberRoleCode?: string;
};

type SetupApp = {
  modules?: Record<string, SetupModuleConfig>;
  statusMappings?: Record<string, StatusMapping>;
  roleMappings?: Record<string, RoleMapping>;
  defaults?: SetupDefaults;
  updatedAt?: any;
  updatedBy?: string;
};
// ===========================================

async function requireIdToken(req: Request) {
  const authHeader = String(req.headers.authorization || "");
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!idToken) return {error: "Missing token"} as const;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return {decoded} as const;
  } catch {
    return {error: "Invalid token"} as const;
  }
}

async function getSetupApp(): Promise<SetupApp | null> {
  const snap = await db.collection("setup").doc("app").get();
  if (!snap.exists) return null;
  return (snap.data() as SetupApp) || null;
}

function defaultScreenForRoleKey(_roleKey: string): string {
  return "home";
}

function computeAllowedActions(roleKey: string): string[] {
  const actions: string[] = [];
  const {adminRoleKeys, memberRoleKeys, godzinkiRoleKeys} = svcCfg;
  if (memberRoleKeys.includes(roleKey)) {
    actions.push("gear.reserve", "basen.enroll", "events.submit");
  }
  // Sympatyk: wyłącznie zapis na basen (bez rezerwacji sprzętu / zgłaszania imprez / godzinek).
  if (roleKey === "rola_sympatyk") {
    actions.push("basen.enroll");
  }
  // Kursant: rezerwuje sprzęt jak kandydat (te same limity). Faktyczne bramkowanie
  // robi flaga setup/vars_kurs.vars.kurs_wypożycza (getKursWypozyczaFlag) + okno
  // szkoleniówki (patrz getSetup oraz gear_bundle_service). Bez zgłaszania imprez /
  // standardowych godzinek.
  if (roleKey === "rola_kursant") {
    actions.push("gear.reserve", "basen.enroll");
  }
  if (godzinkiRoleKeys.includes(roleKey)) {
    actions.push("godzinki.submit");
  }
  if (adminRoleKeys.includes(roleKey)) {
    actions.push("admin.pending", "basen.admin", "events.admin");
  }
  return actions;
}

function requireAdminEmail(email: string): boolean {
  return String(email || "").toLowerCase() === "admin@morzkulc.pl";
}


/**
 * Splits and normalises an array of email/uid strings stored in Firestore.
 * Each element may contain multiple values separated by commas, which is
 * convenient when editing the list in the Firebase console or admin tools.
 */
function flattenEmails(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  return (arr as unknown[])
    .flatMap((e) => String(e).split(",").map((s) => s.trim().toLowerCase()))
    .filter(Boolean);
}

/**
 * Filters setup.modules to only those the given user can see.
 *
 * Filtering rules (must match canSeeModule in access_control.js):
 *   - uid/email in access.usersBlock                 → hidden (always, even for test users)
 *   - statusMappings[statusKey].blocksAccess === true → all modules hidden
 *   - module.enabled !== true                        → hidden UNLESS uid/email in testUsersAllow
 *   - access.mode === "off"                          → hidden UNLESS uid/email in testUsersAllow
 *   - access.mode === "test" and uid/email not in testUsersAllow → hidden
 *   - access.mode === "prod" and rolesAllowed empty  → hidden
 *   - access.mode === "prod" and roleKey not in rolesAllowed → hidden
 *
 * When a module is shown via testUsersAllow override (enabled=false or mode=off),
 * the response includes testUserGranted:true so the frontend can bypass its own guards.
 * Sensitive fields (testUsersAllow, usersBlock) are otherwise stripped from the response.
 */
function filterSetupForUser(
  setup: SetupApp,
  uid: string,
  email: string,
  roleKey: string,
  statusKey: string
): SetupApp {
  const statusBlocked =
    setup.statusMappings?.[statusKey]?.blocksAccess === true;

  const emailLower = email.toLowerCase();
  const filteredModules: Record<string, SetupModuleConfig> = {};

  for (const [id, cfg] of Object.entries(setup.modules || {})) {
    const access = cfg.access || {};

    // testUsersAllow sprawdzamy najwcześniej — może nadpisać disabled/off
    const testAllow = flattenEmails(access.testUsersAllow);
    const isTestUser = testAllow.includes(uid) || testAllow.includes(emailLower);

    // usersBlock wygrywa zawsze, nawet nad testUsersAllow
    const usersBlock = flattenEmails(access.usersBlock);
    if (usersBlock.includes(uid) || usersBlock.includes(emailLower)) continue;

    // Czytamy mode i rolesAllowed przed sprawdzeniem enabled —
    // mode=test z pasującą rolą może ominąć blokadę enabled:false
    const mode = String(access.mode || "prod");
    const rolesAllowed = Array.isArray(access.rolesAllowed) ?
      access.rolesAllowed.map(String) :
      [];
    const isRoleAllowed = rolesAllowed.includes(roleKey);

    const canBypassEnabled = isTestUser || (mode === "test" && isRoleAllowed);
    if (!cfg.enabled && !canBypassEnabled) continue;
    if (statusBlocked) continue;

    if (mode === "off") {
      if (!isTestUser) continue;
    } else if (mode === "test") {
      if (!isTestUser && !isRoleAllowed) continue;
    } else {
      // prod
      if (rolesAllowed.length === 0) continue;
      if (!isRoleAllowed) continue;
    }

    // Moduł widoczny — pomiń wrażliwe pola z access przed zwróceniem.
    // Gdy testUsersAllow nadpisało disabled/off/test, dodaj flagę testUserGranted
    // żeby frontend mógł pominąć swoje własne blokady.
    const testUserOverride = isTestUser && (!cfg.enabled || mode === "off" || mode === "test");
    const safeAccess: ModuleAccess = {
      mode: access.mode,
      rolesAllowed: access.rolesAllowed,
      ...(testUserOverride ? {testUserGranted: true} : {}),
    };

    filteredModules[id] = {...cfg, enabled: true, access: safeAccess};
  }

  return {
    ...setup,
    modules: filteredModules,
  };
}

/**
 * GET /api/setup (authenticated)
 * Returns setup filtered to modules visible for the requesting user.
 * Sensitive access fields (testUsersAllow, usersBlock) are stripped from the response.
 */
const getSetupRoute = async (req: Request, res: Response) => {
  if (sendPreflight(req, res)) return;

  if (!requireAllowedHost(req, res)) return;
  setCorsHeaders(req, res);

  corsHandler(req, res, async () => {
    try {
      const tokenCheck = await requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }

      const uid = tokenCheck.decoded.uid;
      const email = String(tokenCheck.decoded.email || "").trim().toLowerCase();

      const [setup, userSnap, kursWypozyczaFlag] = await Promise.all([
        getSetupApp(),
        db.collection("users_active").doc(uid).get(),
        getKursWypozyczaFlag(db),
      ]);

      if (!setup) {
        res.status(200).json({ok: true, setup: null, setupMissing: true});
        return;
      }

      const userData = userSnap.exists ? (userSnap.data() as any) : null;
      const roleKey = accessRoleKeyOf(userData);
      const statusKey = String(userData?.status_key || "");

      const kursModuleCfg = Object.values(setup.modules || {}).find(
        (m: any) => String(m?.type || "").toLowerCase() === "kurs" ||
                    String(m?.label || "").toLowerCase() === "kurs"
      ) as any;
      const kursTestUsers = flattenEmails(kursModuleCfg?.access?.testUsersAllow);
      const isKursPreview = kursTestUsers.includes(uid) || kursTestUsers.includes(email);
      const effectiveRoleKey = isKursPreview ? "rola_kursant" : roleKey;

      const filteredSetup = filterSetupForUser(setup, uid, email, effectiveRoleKey, statusKey);

      let kursWypozycza = kursWypozyczaFlag;
      let kursExpired = false;
      // Dla realnych kursantów policz okno wypożyczeń (do końca września roku
      // szkoleniówki). W oknie kursant rezerwuje jak kandydat; po oknie traktujemy
      // go jak sympatyka (kursExpired) — przycisk rezerwacji wyłączony, a aplikacja
      // pokazuje komunikat o wygaśnięciu. role_key NIE jest zmieniany automatem —
      // docelową rolę nadaje zarząd ręcznie w arkuszu (patrz panel zarządu: kursanci
      // po terminie). Tryb podglądu (kursPreviewMode) zostaje na samej fladze.
      if (roleKey === "rola_kursant") {
        const rok = parseSchoolYear(userData?.admin?.schoolYear ?? null);
        const now = new Date();
        const todayIso = now.toISOString().slice(0, 10);
        const hasRok = rok !== null;
        const windowEnd = hasRok ? `${rok}-${await getKursWindowEndSuffix(db)}` : "";
        // Okno otwarte: tegoroczna szkoleniówka i przed końcem szkoleniówki (setup/vars_kurs.koniec_kursu).
        const windowOpen = hasRok && rok === now.getUTCFullYear() && todayIso <= windowEnd;
        // Wygasł: znamy rok i minął już koniec szkoleniówki tego roku (lub rok przeszły).
        kursExpired = hasRok && todayIso > windowEnd;
        if (!windowOpen) kursWypozycza = false;
      }

      res.status(200).json({
        ok: true,
        setup: filteredSetup,
        setupMissing: false,
        kursWypozycza,
        kursExpired,
        // Progi wieku do sprawdzania daty urodzenia w przeglądarce (public/core/birth_date.js).
        ageLimits: (await getAppVars(db)).ageLimits,
        ...(isKursPreview ? {kursPreviewMode: true} : {}),
      });
    } catch (err) {
      const e = err as {message?: string; code?: string; stack?: string};
      logger.error("getSetup failed", {message: e?.message, code: e?.code, stack: e?.stack});
      res.status(500).json({error: "Server error", message: e?.message || String(err)});
    }
  });
};
export const getSetup = onRequest({invoker: "private"}, getSetupRoute);

/**
 * POST /api/admin/setup (authenticated + admin)
 * Body: { modules: { [id]: SetupModuleConfig } }
 */
const adminPutSetupRoute = async (req: Request, res: Response) => {
  if (sendPreflight(req, res)) return;

  if (!requireAllowedHost(req, res)) return;
  setCorsHeaders(req, res);

  corsHandler(req, res, async () => {
    try {
      const tokenCheck = await requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }

      const decoded = tokenCheck.decoded;
      const email = String(decoded.email || "");
      if (!requireAdminEmail(email)) {
        res.status(403).json({error: "Forbidden"});
        return;
      }

      const body = (req.body || {}) as {modules?: Record<string, SetupModuleConfig>};

      let modules: Record<string, SetupModuleConfig> | null = null;

      if (
        body.modules &&
        typeof body.modules === "object" &&
        !Array.isArray(body.modules)
      ) {
        modules = body.modules;
      }

      if (!modules) {
        res.status(400).json({error: "Missing body.modules{}"});
        return;
      }

      await db.collection("setup").doc("app").set(
        {
          modules,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: email,
        },
        {merge: true}
      );

      res.status(200).json({ok: true, count: Object.keys(modules).length});
    } catch (err) {
      const e = err as {message?: string; code?: string; stack?: string};
      logger.error("adminPutSetup failed", {message: e?.message, code: e?.code, stack: e?.stack});
      res.status(500).json({error: "Server error", message: e?.message || String(err)});
    }
  });
};
export const adminPutSetup = onRequest({invoker: "private"}, adminPutSetupRoute);

/**
 * POST /api/register (authenticated)
 */
const registerUserRoute = async (req: Request, res: Response) => {
  return handleRegisterUser(req, res, {
    db,
    admin,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    getSetupApp,
    defaultScreenForRoleKey,
    computeAllowedActions,
    enqueueMemberSheetSync,
    enqueueWorkspaceGroupsRoleSync,
    memberRoleKeys,
  });
};
export const registerUser = onRequest({invoker: "private"}, registerUserRoute);

/**
 * GET /api/nickname-availability?nickname=XXX (authenticated)
 * Sprawdza czy ksywa jest wolna (case-insensitive) — używane przez przycisk
 * "Sprawdź dostępność" w formularzu rejestracji oraz jako pomocnicze info przed
 * wysłaniem formularza (ostateczna walidacja unikalności jest w /api/register).
 */
const checkNicknameAvailabilityRoute = async (req: Request, res: Response) => {
  return handleCheckNicknameAvailability(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const checkNicknameAvailability = onRequest({invoker: "private"}, checkNicknameAvailabilityRoute);

/**
 * GET /api/gear/kayaks (authenticated)
 */
const getGearKayaksRoute = async (req: Request, res: Response) => {
  return handleGetGearKayaks(req, res, {
    db,
    admin,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const getGearKayaks = onRequest({invoker: "private"}, getGearKayaksRoute);

/**
 * GET /api/gear/items (authenticated)
 */
const getGearItemsRoute = async (req: Request, res: Response) => {
  return handleGetGearItems(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const getGearItems = onRequest({invoker: "private"}, getGearItemsRoute);

/**
 * GET /api/gear/my-reservations (authenticated)
 */
const getGearMyReservationsRoute = async (req: Request, res: Response) => {
  return handleGearMyReservations(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const getGearMyReservations = onRequest({invoker: "private"}, getGearMyReservationsRoute);

/**
 * POST /api/gear/reservations/create (authenticated)
 */
const createGearReservationRoute = async (req: Request, res: Response) => {
  return handleGearReservationCreate(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    memberRoleKeys: svcCfg.memberRoleKeys,
  });
};
export const createGearReservation = onRequest({invoker: "private"}, createGearReservationRoute);

/**
 * POST /api/gear/reservations/create-bundle (authenticated)
 */
const createBundleGearReservationRoute = async (req: Request, res: Response) => {
  return handleGearBundleReservationCreate(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    memberRoleKeys: svcCfg.memberRoleKeys,
  });
};
export const createBundleGearReservation = onRequest({invoker: "private"}, createBundleGearReservationRoute);

/**
 * POST /api/gear/reservations/update-items (authenticated)
 * Kierownik edytuje listę przedmiotów już złożonej rezerwacji na imprezę
 * klubową (jedyny typ rezerwacji, dla którego to wspierane — patrz
 * updateBundleReservationItems).
 */
const updateBundleGearReservationItemsRoute = async (req: Request, res: Response) => {
  return handleGearBundleReservationUpdateItems(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const updateBundleGearReservationItems = onRequest({invoker: "private"}, updateBundleGearReservationItemsRoute);

/**
 * GET /api/gear/items/availability?category=X&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD (authenticated)
 */
const getGearItemAvailabilityRoute = async (req: Request, res: Response) => {
  return handleGetGearItemAvailability(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const getGearItemAvailability = onRequest({invoker: "private"}, getGearItemAvailabilityRoute);

/**
 * POST /api/gear/damage-report (authenticated, memberRoleKeys — kandydat/czlonek/kr/zarzad)
 */
const submitGearDamageReportRoute = async (req: Request, res: Response) => {
  return handleSubmitGearDamageReport(req, res, {
    db,
    bucket: admin.storage().bucket(),
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    memberRoleKeys,
  });
};
export const submitGearDamageReport = onRequest({invoker: "private"}, submitGearDamageReportRoute);

/**
 * POST /api/gear/reservations/update (authenticated)
 */
const updateGearReservationRoute = async (req: Request, res: Response) => {
  return handleGearReservationUpdate(req, res, {
    db,
    sendPreflight,


    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const updateGearReservation = onRequest({invoker: "private"}, updateGearReservationRoute);

/**
 * POST /api/gear/reservations/cancel (authenticated)
 */
const cancelGearReservationRoute = async (req: Request, res: Response) => {
  return handleGearReservationCancel(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const cancelGearReservation = onRequest({invoker: "private"}, cancelGearReservationRoute);

/**
 * POST /api/admin/gear-reservations/cancel (authenticated, role: zarzad/kr)
 * Wymuszone anulowanie DOWOLNEJ aktywnej rezerwacji sprzętu przez zarząd/KR,
 * ze zwrotem godzinek właścicielowi. Wymaga podania powodu (audyt).
 */
const adminCancelGearReservationRoute = async (req: Request, res: Response) => {
  return handleAdminGearReservationCancel(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const adminCancelGearReservation = onRequest({invoker: "private"}, adminCancelGearReservationRoute);

/**
 * GET /api/gear/favorites?category=kayaks (authenticated)
 */
const getGearFavoritesRoute = async (req: Request, res: Response) => {
  return handleGetGearFavorites(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const getGearFavorites = onRequest({invoker: "private"}, getGearFavoritesRoute);

/**
 * POST /api/gear/favorites/toggle (authenticated)
 */
const gearFavoriteToggleRoute = async (req: Request, res: Response) => {
  return handleGearFavoriteToggle(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const gearFavoriteToggle = onRequest({invoker: "private"}, gearFavoriteToggleRoute);

/**
 * Kolejkuje zadanie serwisowe zapisu godzinek do Google Sheets.
 * Fire-and-forget — nie blokuje odpowiedzi na zgłoszenie.
 */
async function enqueueGodzinkiSheetWrite(recordId: string, uid: string): Promise<void> {
  const jobRef = db.collection("service_jobs").doc();
  await jobRef.set({
    id: jobRef.id,
    taskId: "godzinki.writeToSheet",
    payload: {recordId, uid},
    status: "queued",
    attempts: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Apps Script sync bridge
//
// Endpoint wołany z Apps Script (UrlFetchApp) tokenem uruchamiającego użytkownika.
// Pozwala zarządowi/KR (konta @gmail) wyzwalać sync z arkusza BEZ AdminDirectory
// i BEZ bezpośrednich zapisów Firestore (te wymagają IAM, którego @gmail nie mają).
// invoker:"public" — funkcja sama autoryzuje (token Google + rola w users_active).
// ─────────────────────────────────────────────────────────────────────────────

const APPS_SCRIPT_SYNC_ALLOWED_TASKS = new Set<string>([
  "setup.syncFromSheet",
  "users.syncFieldsFromSheet",
  "users.syncRolesFromSheet",
  "events.syncFromSheet",
  "godzinki.syncFromSheet",
  "godzinki.importTransitionFromSheet",
  "gear.syncAllFromSheet",
  "opening.reconcile",
]);

// Buduje krótkie, przyjazne podsumowanie PL na podstawie wyniku taska (bez nazw funkcji/ID).
function buildAppsScriptSyncSummary(taskId: string, details: any): string {
  const d = details || {};
  const n = (v: any) => (v === null || v === undefined ? "0" : String(v));
  switch (taskId) {
  case "setup.syncFromSheet":
    return `Ustawienia zsynchronizowane.\nModuły: ${n(d.modules)} · zmienne (członkowie): ${n(d.varsMembers)} · zmienne (sprzęt): ${n(d.varsGear)}.`;
  case "users.syncFieldsFromSheet":
    return `Dane członków zsynchronizowane.\nSprawdzono: ${n(d.found)} · zaktualizowano: ${n(d.patched)} · bez zmian: ${n(d.unchanged)}.` +
      (Number(d.roleStatusChanged) > 0 ? `\nZmiany ról/statusów: ${n(d.roleStatusChanged)} — przetwarzane w tle.` : "") +
      (Number(d.linkedByEmail) > 0 ? `\nPołączono konta z wierszami po e-mailu: ${n(d.linkedByEmail)}.` : "") +
      (Number(d.notFound) > 0 ? `\nNie znaleziono w bazie: ${n(d.notFound)}.` : "");
  case "users.syncRolesFromSheet":
    return `Role i statusy zsynchronizowane.\nZaktualizowano: ${n(d.updated)} · bez zmian: ${n(d.unchanged)}.`;
  case "events.syncFromSheet":
    return `Imprezy zsynchronizowane.\nDodane/zmienione: ${n(d.upserted)} · pominięte: ${n(d.skipped)}.` +
      (Number(d.removed) > 0 ? `\nUsunięte (skasowane z arkusza): ${n(d.removed)}.` : "") +
      (Number(d.backfilled) > 0 ? `\nUzupełnione w arkuszu (zaległe zgłoszenia z aplikacji): ${n(d.backfilled)}.` : "") +
      (Number(d.confirmedInSheet) > 0 ? `\nPotwierdzone w kolumnie zsynchronizowano: ${n(d.confirmedInSheet)}.` : "");
  case "godzinki.importTransitionFromSheet":
    return `Korekty/godzinki 2026 zaimportowane.\nDodane: +${n(d.createdEarn)} zgłoszeń, +${n(d.createdSpend)} potrąceń · pominięte (już zsync.): ${n(d.alreadySynced)} · oczekujące (bez TAK): ${n(d.pending)}.` +
      ((Number(d.skippedNoEmail || 0) + Number(d.skippedBadAmount || 0) + Number(d.skippedBadDate || 0)) > 0 ?
        `\nPominięte z błędami: brak e-mail ${n(d.skippedNoEmail)}, zła kwota ${n(d.skippedBadAmount)}, zła data ${n(d.skippedBadDate)}.` : "") +
      (Number(d.errors || 0) > 0 ? `\nBłędy: ${n(d.errors)} — sprawdź logi.` : "");
  case "godzinki.syncFromSheet":
    return `Godzinki zsynchronizowane.\nZatwierdzone: ${n(d.approved)} · skorygowane: ${n(d.corrected)} · uzupełnione w arkuszu: ${n(d.backfilled)}.` +
      (Number(d.approvalRejected) > 0 ? `\nOdrzucone zatwierdzenia (przeterminowane/nieaktualny wykup): ${n(d.approvalRejected)} — wiersze bez daty w "Zsynchronizowano".` : "") +
      (Number(d.unapproveIgnored) > 0 ? `\nUwaga: cofnięcia TAK→NIE są ignorowane (${n(d.unapproveIgnored)}).` : "") +
      (Number(d.duplicateId) > 0 ? `\nZduplikowane ID w arkuszu: ${n(d.duplicateId)} — pominięte.` : "");
  case "gear.syncAllFromSheet":
    if (d.validationError) {
      return "Synchronizacja wstrzymana — sprawdź dane.";
    }
    return `Sprzęt ${d.dryRun ? "(podgląd — nic nie zapisano)" : "zsynchronizowany"}.\n` +
      `Dodane/zmienione: ${n(d.upserted)} · zezłomowane (brak w arkuszu): ${n(d.scrapped)}.` +
      (Number(d.duplicateId) > 0 ? `\nUWAGA: zduplikowane ID w arkuszu: ${n(d.duplicateId)} — sztuki pominięte (pierwsza została), popraw ID i zsynchronizuj ponownie.` : "") +
      (Number(d.duplicateNumber) > 0 ? `
UWAGA: powtórzone numery sprzętu: ${n(d.duplicateNumber)} — różne sztuki wyglądają w aplikacji identycznie; nadaj unikalne numery (szczegóły w panelu zarządu).` : "");
  case "opening.reconcile": {
    if (d.userFound === false) {
      return `Nie znaleziono użytkownika o adresie ${d.targetEmail || "(brak)"} w bazie. Sprawdź, czy osoba jest zarejestrowana w aplikacji.`;
    }
    if (Number(d.matched) === 0) {
      return `Nie znaleziono dopasowania w bilansie otwarcia dla ${d.targetEmail || "(brak)"} (po mailu ani po imieniu i nazwisku).`;
    }
    const hoursMsg = Number(d.hoursCreated) > 0 ?
      "utworzono pulę godzinek z bilansu" :
      Number(d.hoursFixed) > 0 ?
        "zaktualizowano istniejącą pulę godzinek z bilansu" :
        "brak godzinek do naliczenia w bilansie (0 h)";
    let msg = `Bilans otwarcia uzgodniony dla ${d.targetEmail || "użytkownika"}.\n${hoursMsg}.`;
    if (Number(d.emailUpdated) > 0) msg += "\nMail w bilansie otwarcia zaktualizowano na podany adres.";
    if (Number(d.emailUpdateSkipped) > 0) msg += "\nUWAGA: maila w bilansie NIE zmieniono — podany adres występuje już w innym wierszu (sprawdź duplikat).";
    return msg;
  }
  default:
    return "Synchronizacja zakończona.";
  }
}

async function verifyGoogleAccessToken(token: string): Promise<{email: string; verified: boolean} | null> {
  try {
    const resp = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: {Authorization: `Bearer ${token}`},
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const email = String(data?.email || "").trim().toLowerCase();
    const verified = data?.email_verified === true || data?.email_verified === "true";
    if (!email) return null;
    return {email, verified};
  } catch {
    return null;
  }
}

/**
 * POST /api/apps-script-sync  (przez Firebase Hosting rewrite → invoker: "private")
 * Body: { taskId: string, payload?: object }
 * Header: Authorization: Bearer <ScriptApp.getOAuthToken()>
 *
 * Wołane z Apps Script pod URL Hostingu (Hosting ma uprawnienie do wywołania prywatnej
 * funkcji). Org policy blokuje allUsers, więc NIE używamy public invoker.
 */
export const appsScriptSync = onRequest({invoker: "private"}, async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.status(204).send("");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ok: false, error: "Method not allowed"});
      return;
    }

    const authHeader = String(req.headers.authorization || "");
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      res.status(401).json({ok: false, error: "Missing bearer token"});
      return;
    }

    const who = await verifyGoogleAccessToken(m[1].trim());
    if (!who || !who.email) {
      res.status(401).json({ok: false, error: "Invalid token"});
      return;
    }
    if (!who.verified) {
      res.status(403).json({ok: false, error: "Email not verified"});
      return;
    }

    // Autoryzacja: admin@ albo rola zarząd/KR w users_active
    let authorized = requireAdminEmail(who.email);
    if (!authorized) {
      const snap = await db.collection("users_active").where("email", "==", who.email).limit(1).get();
      if (!snap.empty) {
        const roleKey = accessRoleKeyOf(snap.docs[0].data());
        authorized = adminRoleKeys.includes(roleKey);
      }
    }
    if (!authorized) {
      res.status(403).json({ok: false, error: "Brak uprawnień (tylko zarząd/KR)"});
      return;
    }

    const body = (req.body || {}) as any;
    const taskId = String(body?.taskId || "").trim();
    if (!APPS_SCRIPT_SYNC_ALLOWED_TASKS.has(taskId)) {
      res.status(400).json({ok: false, error: `taskId niedozwolony: ${taskId}`});
      return;
    }

    const inPayload = body?.payload && typeof body.payload === "object" ? body.payload : {};
    const payload = {...inPayload, requestedBy: who.email};

    // Synchronicznie — żeby zwrócić użytkownikowi realne podsumowanie wyniku.
    const result = await (await loadRunTaskById())(taskId, payload, {dryRun: false});

    // Zmiana wymagająca decyzji osoby uruchamiającej sync (np. cofnięcie składek) — arkusz pyta i ponawia z potwierdzeniem.
    if (!result.ok && (result.details as any)?.needsConfirmation) {
      // `error` — czytelny komunikat także dla starszej wersji skryptu, która nie umie zapytać o potwierdzenie.
      res.status(409).json({
        ok: false, needsConfirmation: true, message: result.message, confirm: (result.details as any).confirmDuesRollback || [],
        error: result.message + "\n\n(Jeśli widzisz tylko przycisk OK, ta wersja menu arkusza nie umie potwierdzić — zgłoś to administratorowi aplikacji.)",
      });
      return;
    }
    if (!result.ok) {
      logger.warn("appsScriptSync: task failed", {taskId, who: who.email, message: result.message});
      res.status(422).json({ok: false, error: result.message || "Synchronizacja nie powiodła się"});
      return;
    }

    logger.info("appsScriptSync: done", {taskId, who: who.email});
    // Walidacja zakończona ok:true, ale z komunikatem dla użytkownika (np. prywatne kajaki bez maila).
    const summary = (result.details as any)?.validationError ?
      (result.message || "Synchronizacja wstrzymana — sprawdź dane.") :
      buildAppsScriptSyncSummary(taskId, result.details);
    res.status(200).json({ok: true, summary});
  } catch (err: any) {
    logger.error("appsScriptSync failed", {message: err?.message, stack: err?.stack});
    res.status(500).json({ok: false, error: "Server error", message: err?.message || String(err)});
  }
});

/**
 * GET /api/godzinki (authenticated)
 */
const getGodzinkiRoute = async (req: Request, res: Response) => {
  return handleGetGodzinki(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    godzinkiRoleKeys: svcCfg.godzinkiRoleKeys,
  });
};
export const getGodzinki = onRequest({invoker: "private"}, getGodzinkiRoute);

/**
 * GET /api/gear/kayak-reservations?kayakId=X (authenticated)
 * Zwraca aktywne rezerwacje danego kajaka z nazwami użytkowników.
 */
const getKayakReservationsRoute = async (req: Request, res: Response) => {
  return handleGetKayakReservations(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const getKayakReservations = onRequest({invoker: "private"}, getKayakReservationsRoute);

/**
 * POST /api/godzinki/submit (authenticated)
 */
const submitGodzinkiRoute = async (req: Request, res: Response) => {
  return handleSubmitGodzinki(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    godzinkiRoleKeys: svcCfg.godzinkiRoleKeys,
    enqueueGodzinkiSheetWrite,
  });
};
export const submitGodzinki = onRequest({invoker: "private"}, submitGodzinkiRoute);

/**
 * POST /api/godzinki/purchase (authenticated)
 * Zgłasza wniosek o wykup salda ujemnego (pending → zatwierdza admin przez Sheets).
 */
const purchaseGodzinkiRoute = async (req: Request, res: Response) => {
  return handleGodzinkiPurchase(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    enqueueGodzinkiSheetWrite,
    godzinkiRoleKeys: svcCfg.godzinkiRoleKeys,
  });
};
export const purchaseGodzinki = onRequest({invoker: "private"}, purchaseGodzinkiRoute);

/**
 * Kolejkuje zadanie serwisowe synchronizacji członka z Google Sheets.
 * Używa deterministycznego ID joba (`sheet-sync:{uid}`) — zapobiega duplikatom.
 * Jeśli job jest już w stanie "queued" lub "running" — nie tworzy nowego.
 * Jeśli job jest w stanie "done", "failed" lub "dead" — nadpisuje (re-enqueue).
 */
async function enqueueMemberSheetSync(uid: string): Promise<void> {
  const jobId = `sheet-sync:${uid}`;
  const jobRef = db.collection("service_jobs").doc(jobId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.runTransaction(async (tx) => {
    const existing = await tx.get(jobRef);
    if (existing.exists) {
      const status = String((existing.data() as any)?.status || "");
      if (status === "queued" || status === "running") return; // już w kolejce lub działa — pomiń
    }
    tx.set(jobRef, {
      id: jobId,
      taskId: "members.syncToSheet",
      payload: {uid},
      status: "queued",
      attempts: 0,
      createdAt: existing.exists ? existing.data()?.createdAt : now,
      updatedAt: now,
    });
  });
}

/**
 * Kolejkuje rekoncyliację grup Workspace (lista@ i grupy z roleMappings) dla jednego
 * użytkownika, tuż po tym jak role_key zmienił się poza sheet-syncem (dopasowanie do
 * bilansu otwarcia / self-declared kursant — patrz registerUserHandler.ts). Deterministyczne
 * ID joba (`role-groups-sync:{uid}`) — ten sam wzorzec re-enqueue co enqueueMemberSheetSync.
 * Patrz Audyty/13.08_NAPRAWA_UPRAWNIEŃ_LISTA.MD.
 */
async function enqueueWorkspaceGroupsRoleSync(uid: string, email: string): Promise<void> {
  const jobId = `role-groups-sync:${uid}`;
  const jobRef = db.collection("service_jobs").doc(jobId);
  const now = admin.firestore.FieldValue.serverTimestamp();

  await db.runTransaction(async (tx) => {
    const existing = await tx.get(jobRef);
    if (existing.exists) {
      const status = String((existing.data() as any)?.status || "");
      if (status === "queued" || status === "running") return; // już w kolejce lub działa — pomiń
    }
    tx.set(jobRef, {
      id: jobId,
      taskId: "users.reconcileWorkspaceGroups",
      payload: {email},
      status: "queued",
      attempts: 0,
      createdAt: existing.exists ? existing.data()?.createdAt : now,
      updatedAt: now,
    });
  });
}

/**
 * Kolejkuje zadanie serwisowe zapisu imprezy do Google Sheets.
 */
async function enqueueEventSheetWrite(eventId: string, uid: string): Promise<void> {
  const jobRef = db.collection("service_jobs").doc();
  await jobRef.set({
    id: jobRef.id,
    taskId: "events.writeToSheet",
    payload: {eventId, uid},
    status: "queued",
    attempts: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * GET /api/events (authenticated)
 */
const getEventsRoute = async (req: Request, res: Response) => {
  return handleGetEvents(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const getEvents = onRequest({invoker: "private"}, getEventsRoute);

/**
 * GET /api/admin/pending (authenticated, role: zarzad/kr)
 * Zwraca listę godzinek i imprez oczekujących na zatwierdzenie.
 */
const getAdminPendingRoute = async (req: Request, res: Response) => {
  return handleGetAdminPending(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const getAdminPending = onRequest({invoker: "private"}, getAdminPendingRoute);

/**
 * GET /api/admin/reports/gear-rentals (authenticated, role: zarzad/kr)
 * Raport wypożyczonego sprzętu w zadanym zakresie czasu.
 */
const getAdminGearRentalsRoute = async (req: Request, res: Response) => {
  return handleGetAdminGearRentals(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const getAdminGearRentals = onRequest({invoker: "private"}, getAdminGearRentalsRoute);

/**
 * GET /api/admin/reports/gear-top-rentals (authenticated, role: zarzad/kr)
 * Raport „Najczęściej wypożyczane" — suma dni wypożyczenia per sprzęt w zadanym zakresie.
 */
const getAdminGearTopRentalsRoute = async (req: Request, res: Response) => {
  return handleGetAdminGearTopRentals(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const getAdminGearTopRentals = onRequest({invoker: "private"}, getAdminGearTopRentalsRoute);

/**
 * GET /api/admin/reports/gear-damage (authenticated, role: zarzad/kr)
 * Raport zgłoszeń uszkodzeń sprzętu (status "open"), posortowany wg wagi.
 */
const getAdminGearDamageReportsRoute = async (req: Request, res: Response) => {
  return handleGetAdminGearDamageReports(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const getAdminGearDamageReports = onRequest({invoker: "private"}, getAdminGearDamageReportsRoute);

/**
 * GET /api/admin/reports/member-activity (authenticated, role: zarzad/kr)
 * Ranking członków wg wypracowanych godzinek w zadanym zakresie czasu.
 */
const getAdminMemberActivityRoute = async (req: Request, res: Response) => {
  return handleGetAdminMemberActivity(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const getAdminMemberActivity = onRequest({invoker: "private"}, getAdminMemberActivityRoute);

/**
 * GET /api/admin/reports/member-dues (authenticated, role: zarzad/kr)
 * Składki pełnych członków: zaległości, opłacone, uprawnieni do głosowania.
 */
const getAdminMemberDuesRoute = async (req: Request, res: Response) => {
  return handleGetAdminMemberDues(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const getAdminMemberDues = onRequest({invoker: "private"}, getAdminMemberDuesRoute);

/**
 * GET /api/admin/reports/user-activity (authenticated, role: zarzad/kr)
 * Historia godzinek (przyznane + wydane) dowolnego użytkownika po e-mailu, w zakresie czasu.
 */
const getAdminUserActivityRoute = async (req: Request, res: Response) => {
  return handleGetAdminUserActivity(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const getAdminUserActivity = onRequest({invoker: "private"}, getAdminUserActivityRoute);

/**
 * POST /api/admin/events/sync-calendar (authenticated, role: zarzad/kr)
 * Kolejkuje job events.syncCalendar — synchronizuje zatwierdzone imprezy z Google Calendar.
 */
const adminEventsSyncCalendarRoute = async (req: Request, res: Response) => {
  return handleAdminEventsSyncCalendar(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const adminEventsSyncCalendar = onRequest({invoker: "private"}, adminEventsSyncCalendarRoute);

/**
 * POST /api/admin/approve (authenticated, role: zarzad/kr)
 * Zatwierdza godzinkę lub imprezę z aplikacji + write-back do arkusza.
 */
const adminApproveRoute = async (req: Request, res: Response) => {
  return handleAdminApprove(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const adminApprove = onRequest({invoker: "private"}, adminApproveRoute);

/**
 * POST /api/admin/reject (authenticated, role: zarzad/kr)
 * Odrzuca godzinkę lub imprezę z aplikacji (ODRZUCONA w arkuszu, usunięcie z kalendarza).
 */
const adminRejectRoute = async (req: Request, res: Response) => {
  return handleAdminReject(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const adminReject = onRequest({invoker: "private"}, adminRejectRoute);

/**
 * POST /api/admin/gear-damage/resolve (authenticated, role: zarzad/kr)
 */
const resolveGearDamageReportRoute = async (req: Request, res: Response) => {
  return handleResolveGearDamageReport(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const resolveGearDamageReport = onRequest({invoker: "private"}, resolveGearDamageReportRoute);

/**
 * POST /api/events/submit (authenticated, role: czlonek/zarzad/kr)
 */
const submitEventRoute = async (req: Request, res: Response) => {
  return handleSubmitEvent(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    enqueueEventSheetWrite,
    memberRoleKeys,
  });
};
export const submitEvent = onRequest({invoker: "private"}, submitEventRoute);

/**
 * Kolejkuje powiadomienie o anulowaniu terminu/slotu basenowego.
 */
async function enqueueBasenSessionCancelledNotify(sessionId: string, reason?: string): Promise<void> {
  const jobRef = db.collection("service_jobs").doc();
  await jobRef.set({
    id: jobRef.id,
    taskId: "basen.notifySessionCancelled",
    payload: {sessionId, ...(reason ? {reason} : {})},
    status: "queued",
    attempts: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Wszystkie endpointy modułu Basen w JEDNEJ funkcji (perf 01.11.2026, P5): moduł jest
 * najczęściej używaną częścią aplikacji, a osobna funkcja na każdą akcję oznaczała osobny
 * zimny start (3,6–5,8 s) przy pierwszym kliknięciu każdej akcji. Jedna instancja rozgrzana
 * otwarciem modułu obsługuje potem zapis, rezygnację, edycję itd. Routing po ścieżce
 * (Hosting przekazuje oryginalną ścieżkę /api/basen/...).
 */
const basenDeps = {
  db,
  sendPreflight,
  requireAllowedHost,
  setCorsHeaders,
  corsHandler,
  requireIdToken,
  adminRoleKeys,
  memberRoleKeys,
  enqueueBasenSessionCancelledNotify,
};

const BASEN_ROUTES: Record<string, (req: any, res: any) => Promise<void>> = {
  "/api/basen/sessions": (req, res) => handleGetBasenSessions(req, res, basenDeps),
  "/api/basen/enroll": (req, res) => handleBasenEnroll(req, res, basenDeps),
  "/api/basen/cancel-enrollment": (req, res) => handleBasenCancelEnrollment(req, res, basenDeps),
  "/api/basen/sessions/create": (req, res) => handleBasenCreateSession(req, res, basenDeps),
  "/api/basen/sessions/cancel": (req, res) => handleBasenCancelSession(req, res, basenDeps),
  "/api/basen/sessions/add-sauna": (req, res) => handleBasenAddSauna(req, res, basenDeps),
  "/api/basen/kayak": (req, res) => handleBasenSetKayak(req, res, basenDeps),
  "/api/basen/instructor": (req, res) => handleBasenSetInstructor(req, res, basenDeps),
  "/api/basen/instructor/claim": (req, res) => handleBasenClaimWaitingStudent(req, res, basenDeps),
  "/api/basen/godziny/my": (req, res) => handleGetBasenMyGodziny(req, res, basenDeps),
  "/api/basen/admin/godziny/users": (req, res) => handleGetBasenAdminGodzinyUsers(req, res, basenDeps),
  "/api/basen/admin/godziny/history": (req, res) => handleGetBasenAdminGodzinyHistory(req, res, basenDeps),
  "/api/basen/admin/godziny/add": (req, res) => handleBasenAdminAddGodziny(req, res, basenDeps),
  "/api/basen/admin/godziny/extra": (req, res) => handleBasenAdminAddGodziny(req, res, basenDeps),
  "/api/basen/order": (req, res) => handleBasenOrder(req, res, basenDeps),
};

export const basenApi = onRequest({invoker: "private"}, async (req, res) => {
  const path = String(req.path || "").replace(/\/+$/, "");
  const route = BASEN_ROUTES[path];
  if (!route) {
    setCorsHeaders(req, res);
    res.status(404).json({error: "Not found"});
    return;
  }
  return route(req, res);
});

/**
 * POST /kmAddLog (authenticated)
 * Dodaje nowy wpis aktywności. Oblicza punkty ON WRITE.
 */
const kmAddLogRoute = async (req: Request, res: Response) => {
  return handleKmAddLog(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    memberRoleKeys,
  });
};
export const kmAddLog = onRequest({invoker: "private"}, kmAddLogRoute);

/**
 * GET /kmMyLogs (authenticated)
 * Moje wpisy aktywności (posortowane po dacie malejąco).
 */
const kmMyLogsRoute = async (req: Request, res: Response) => {
  return handleKmMyLogs(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const kmMyLogs = onRequest({invoker: "private"}, kmMyLogsRoute);

/**
 * GET /kmMyStats (authenticated)
 * Moje statystyki z km_user_stats — odczyt O(1), brak przeliczania.
 */
const kmMyStatsRoute = async (req: Request, res: Response) => {
  return handleKmMyStats(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const kmMyStats = onRequest({invoker: "private"}, kmMyStatsRoute);

/**
 * GET /kmRankings (authenticated)
 * Rankingi: type=km|points|hours, period=year|alltime.
 */
const kmRankingsRoute = async (req: Request, res: Response) => {
  return handleKmRankings(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const kmRankings = onRequest({invoker: "private"}, kmRankingsRoute);

/**
 * GET /kmPlaces (authenticated)
 * Podpowiedzi nazw akwenów: ?q=rad (min 2 znaki).
 */
const kmPlacesRoute = async (req: Request, res: Response) => {
  return handleKmPlaces(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const kmPlaces = onRequest({invoker: "private"}, kmPlacesRoute);

/**
 * GET /kmEventStats (authenticated)
 * Statystyki wywrotolotek per uczestnik dla danej imprezy: ?eventId=XXX
 */
const kmEventStatsRoute = async (req: Request, res: Response) => {
  return handleKmEventStats(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const kmEventStats = onRequest({invoker: "private"}, kmEventStatsRoute);

/**
 * GET /kmMapData (publiczny — bez auth, dane pre-computed)
 * Pre-computed cache lokalizacji aktywności km dla mapy.
 */
const kmMapDataRoute = async (req: Request, res: Response) => {
  return handleKmMapData(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
  });
};
export const kmMapData = onRequest({invoker: "private"}, kmMapDataRoute);

/**
 * POST /kmAdminMergePlaces (admin: rola_zarzad | rola_kr)
 * Scala zduplikowane miejsca w km_places.
 */
const kmAdminMergePlacesRoute = async (req: Request, res: Response) => {
  return handleKmAdminMergePlaces(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const kmAdminMergePlaces = onRequest({invoker: "private"}, kmAdminMergePlacesRoute);

/**
 * GET /api/kurs/info (authenticated: rola_kursant, adminowie, testUsersAllow)
 */
const getKursInfoRoute = async (req: Request, res: Response) => {
  return handleGetKursInfo(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const getKursInfo = onRequest({invoker: "private"}, getKursInfoRoute);

/**
 * GET /api/km/kursant-stats (authenticated: rola_kursant, adminowie)
 */
const getKursantStatsRoute = async (req: Request, res: Response) => {
  return handleGetKursantStats(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const getKursantStats = onRequest({invoker: "private"}, getKursantStatsRoute);

/**
 * GET /api/klub (authenticated: każdy zalogowany)
 * Zwraca dane klubowe: zarząd (funkcje→nazwy), KR, konto/bank, linki.
 */
const getKlubInfoRoute = async (req: Request, res: Response) => {
  return handleGetKlubInfo(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
    adminRoleKeys,
  });
};
export const getKlubInfo = onRequest({invoker: "private"}, getKlubInfoRoute);

/**
 * GET /api/public/site (PUBLICZNY, bez logowania)
 * Dane dla statycznej wizytówki klubu (www.morzkulc.pg.gda.pl): imprezy, zarząd, socjale.
 */
const publicSiteInfoRoute = async (req: Request, res: Response) => {
  return handleGetPublicSite(req, res, {db, requireAllowedHost, setCorsHeaders});
};
export const publicSiteInfo = onRequest({invoker: "private"}, publicSiteInfoRoute);

/**
 * GET/POST /api/kurs/zgloszenie (authenticated Google, wołane z kurs.morzkulc.pl)
 * Formularz zgłoszeniowy na kurs + dane do przelewu. Własne CORS (originy strony kursu).
 */
const kursZgloszenieRoute = async (req: Request, res: Response) => {
  return handleKursZgloszenie(req, res, {db, requireAllowedHost, requireIdToken});
};
export const kursZgloszenie = onRequest({invoker: "private"}, kursZgloszenieRoute);

/**
 * GET /api/admin/kurs/zgloszenia (authenticated, role: zarzad/kr)
 * Lista zgłoszeń bieżącej edycji kursu (lista główna/rezerwowa, dane do przelewu).
 */
const adminKursZgloszeniaRoute = async (req: Request, res: Response) => {
  return handleAdminKursZgloszenia(req, res, {
    db, sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, requireIdToken, adminRoleKeys,
  });
};
export const adminKursZgloszenia = onRequest({invoker: "private"}, adminKursZgloszeniaRoute);

/**
 * POST /api/admin/kurs/zgloszenie (authenticated, role: zarzad/kr)
 * Zadatek wpłacony / pełna wpłata / rezygnacja — przenosi kursanta do arkusza członków lub sprząta.
 */
const adminKursZgloszenieActionRoute = async (req: Request, res: Response) => {
  return handleAdminKursZgloszenieAction(req, res, {
    db, sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, requireIdToken, adminRoleKeys,
  });
};
export const adminKursZgloszenieAction = onRequest({invoker: "private"}, adminKursZgloszenieActionRoute);

/**
 * POST /api/admin/blachy (authenticated, role: zarzad/kr)
 * Rejestr Blach: dodanie / poprawka / usunięcie błędnego wpisu.
 */
const adminBlachyRoute = async (req: Request, res: Response) => {
  return handleAdminBlachy(req, res, {
    db, sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, requireIdToken, adminRoleKeys,
  });
};
export const adminBlachy = onRequest({invoker: "private"}, adminBlachyRoute);

/**
 * /api/blachy/* — procedura nadawania Blach (nominacje, Kapituła, Zarząd, potwierdzenie przyjęcia).
 * Trasa „przyjecie" działa bez logowania (token z maila); pozostałe wymagają ID tokenu.
 */
const blachyApiRoute = async (req: Request, res: Response) => {
  return handleBlachyApi(req, res, {db, sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, requireIdToken});
};
export const blachyApi = onRequest({invoker: "private"}, blachyApiRoute);

const userWeightRoute = async (req: Request, res: Response) => {
  return handleUserWeight(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const userWeight = onRequest({invoker: "private"}, userWeightRoute);

/**
 * POST /api/test/role (authenticated, tylko konta z konta_testowe w Vars_MEMBERS)
 * Konto testowe przełącza sobie rolę — bez arkusza członków i grup Workspace.
 */
const testAccountSetRoleRoute = async (req: Request, res: Response) => {
  return handleTestAccountRole(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const testAccountSetRole = onRequest({invoker: "private"}, testAccountSetRoleRoute);

/**
 * GET/POST /api/profile/notifications (authenticated)
 */
const notificationPrefsRoute = async (req: Request, res: Response) => {
  return handleNotificationPrefs(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const notificationPrefs = onRequest({invoker: "private"}, notificationPrefsRoute);

/**
 * GET/POST /api/profile/data (authenticated) — edycja własnego imienia, nazwiska, telefonu (+ zapis do arkusza).
 * Tylko w appApi (bez osobnej funkcji).
 */
const profileDataRoute = async (req: Request, res: Response) => {
  return handleProfileData(req, res, {db, sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, requireIdToken});
};

/**
 * GET/POST /api/dues (authenticated) — składki/wpisowe członka: stan, zgłoszenie wpłaty, anulowanie.
 * GET/POST /api/admin/dues (zarząd/KR podgląd; akcje tylko skarbnik) — panel „Składki".
 */
const duesRoute = async (req: Request, res: Response) => {
  return handleDues(req, res, {db, sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, requireIdToken});
};
const adminDuesRoute = async (req: Request, res: Response) => {
  return handleAdminDues(req, res, {db, sendPreflight, requireAllowedHost, setCorsHeaders, corsHandler, requireIdToken, adminRoleKeys});
};

/**
 * GET /api/events/interests (authenticated)
 */
const getEventInterestsRoute = async (req: Request, res: Response) => {
  return handleGetEventInterests(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const getEventInterests = onRequest({invoker: "private"}, getEventInterestsRoute);

/**
 * POST /api/events/interest/toggle (authenticated)
 */
const eventInterestToggleRoute = async (req: Request, res: Response) => {
  return handleEventInterestToggle(req, res, {
    db,
    sendPreflight,
    requireAllowedHost,
    setCorsHeaders,
    corsHandler,
    requireIdToken,
  });
};
export const eventInterestToggle = onRequest({invoker: "private"}, eventInterestToggleRoute);

/**
 * SERVICE MODULE EXPORTS
 *
 * Ładowane WARUNKOWO, za bramką FUNCTION_TARGET. Powód: każdy z tych pięciu
 * modułów ciągnie service/runner → registry → 35 tasków → cztery providery
 * z `googleapis`. Przy imporcie statycznym ten łańcuch ładował się w zimnym
 * starcie WSZYSTKICH 65 funkcji HTTP, mimo że potrzebuje go pięć z nich.
 * Zmierzone na produkcji 23.09.2026: boot;dur = 4032 ms (lokalnie 1207 ms,
 * 1739 modułów).
 *
 * Jak to działa: przy deployu FUNCTION_TARGET jest pusty, więc discovery
 * Firebase widzi wszystkie eksporty i wdraża komplet funkcji. W runtime
 * FUNCTION_TARGET niesie nazwę uruchamianej funkcji, więc ładuje się wyłącznie
 * jej moduł. Dla pozostałych 60 funkcji ten łańcuch nie powstaje w ogóle.
 */
const FUNCTION_TARGET = process.env.FUNCTION_TARGET || "";
/** true przy deployu (brak zmiennej) albo gdy to właśnie ta funkcja jest uruchamiana. */
function servingOrDiscovering(name: string): boolean {
  return !FUNCTION_TARGET || FUNCTION_TARGET === name;
}

/* eslint-disable @typescript-eslint/no-var-requires */
if (servingOrDiscovering("onUsersActiveCreated")) {
  exports.onUsersActiveCreated = require("./service/triggers/onUsersActiveCreated").onUsersActiveCreated;
}
if (servingOrDiscovering("onEventApproved")) {
  exports.onEventApproved = require("./service/triggers/onEventApproved").onEventApproved;
}
if (servingOrDiscovering("onServiceJobCreated")) {
  exports.onServiceJobCreated = require("./service/worker/onJobCreatedWorker").onServiceJobCreated;
}
if (servingOrDiscovering("serviceFallbackDaily")) {
  exports.serviceFallbackDaily = require("./service/worker/fallbackDailyWorker").serviceFallbackDaily;
}
if (servingOrDiscovering("adminRunServiceTask")) {
  exports.adminRunServiceTask = require("./service/admin/adminRunTask").adminRunServiceTask;
}
/* eslint-enable @typescript-eslint/no-var-requires */

/**
 * SCHEDULER: Miesięczna opłata za przechowywanie prywatnych kajaków w klubie.
 * Uruchamiany 1. dnia każdego miesiąca o 04:00 czasu warszawskiego.
 */
import {onSchedule} from "firebase-functions/v2/scheduler";
import {effectiveRoleKey as accessRoleKeyOf} from "./modules/users/member_standing";
// runner ładowany DYNAMICZNIE (patrz loadRunTaskById niżej) — import statyczny
// ciągnął za sobą registry.ts → 35 tasków → cztery providery z `googleapis`,
// czyli ~4 s ładowania modułów w zimnym starcie KAŻDEJ z 65 funkcji HTTP, choć
// runnera używa tylko appsScriptSync, adminRunServiceTask i schedulery.
// Zmierzone na produkcji 23.09.2026: boot;dur=4032 ms.
async function loadRunTaskById() {
  const {runTaskById} = await import("./service/runner.js");
  return runTaskById;
}

export const gearPrivateStorageMonthly = onSchedule(
  {schedule: "0 4 1 * *", timeZone: "Europe/Warsaw"},
  async () => {
    logger.info("gearPrivateStorageMonthly: start");
    const result = await (await loadRunTaskById())("gear.chargePrivateStorage", {});
    logger.info("gearPrivateStorageMonthly: charge done", result as unknown as Record<string, unknown>);
    // Po naliczeniu opłat: przegląd sald (snapshot ujemnych do panelu zarządu + maile przy przekroczeniu limitu).
    const review = await (await loadRunTaskById())("godzinki.monthlyBalanceReview", {});
    logger.info("gearPrivateStorageMonthly: balance review done", review as unknown as Record<string, unknown>);
  }
);

/**
 * SCHEDULER: Dzienny sync ról i statusów użytkowników z Google Sheets do Firestore.
 * Uruchamiany codziennie o 04:30 czasu warszawskiego.
 * Odpowiada za aktualizację role_key i status_key na podstawie arkusza członków.
 */
/**
 * SCHEDULER: Dzienny sync danych członków z arkusza (w tym „Składki" — jedyne źródło dat składek,
 * decyzja 01.11.2026). Wpis skarbnika trafia do aplikacji najpóźniej następnego ranka bez klikania
 * „sync członkowie". Walidacja (ID, format daty składek, konflikty) przerywa sync bez zapisów — błąd w logach.
 * 04:20 — przed usersSyncRolesDaily (04:30).
 */
export const usersSyncFieldsDaily = onSchedule(
  {schedule: "20 4 * * *", timeZone: "Europe/Warsaw", timeoutSeconds: 540},
  async () => {
    logger.info("usersSyncFieldsDaily: start");
    const result = await (await loadRunTaskById())("users.syncFieldsFromSheet", {requestedBy: "scheduler"});
    logger.info("usersSyncFieldsDaily: done", result as unknown as Record<string, unknown>);
  }
);

/**
 * SCHEDULER: Niedokończone rejestracje (decyzja 01.11.2026) — codzienne sprawdzenie terminów:
 * jeden mail po 3 dniach od założenia konta, usunięcie po 7 dniach (Vars_MEMBERS: rejestracja_dni_do_przypomnienia,
 * rejestracja_dni_do_usuniecia).
 */
export const usersIncompleteRegistrationDaily = onSchedule(
  {schedule: "10 5 * * *", timeZone: "Europe/Warsaw", timeoutSeconds: 540},
  async () => {
    logger.info("usersIncompleteRegistrationDaily: start");
    const result = await (await loadRunTaskById())("users.incompleteRegistration", {});
    logger.info("usersIncompleteRegistrationDaily: done", result as unknown as Record<string, unknown>);
  }
);

/**
 * SCHEDULER: składki — alert do skarbnika o zgłoszeniach czekających > N dni oraz przypomnienia
 * dla osób, które same je włączyły w profilu (decyzja 02.11.2026: bez automatu dla wszystkich).
 */
export const duesDaily = onSchedule(
  {schedule: "40 7 * * *", timeZone: "Europe/Warsaw", timeoutSeconds: 540},
  async () => {
    logger.info("duesDaily: start");
    const result = await (await loadRunTaskById())("dues.daily", {});
    logger.info("duesDaily: done", result as unknown as Record<string, unknown>);
  }
);

export const usersSyncRolesDaily = onSchedule(
  {schedule: "30 4 * * *", timeZone: "Europe/Warsaw"},
  async () => {
    logger.info("usersSyncRolesDaily: start");
    const result = await (await loadRunTaskById())("users.syncRolesFromSheet", {});
    logger.info("usersSyncRolesDaily: done", result as unknown as Record<string, unknown>);
  }
);

/**
 * SCHEDULER: Dzienna rekoncyliacja członkostwa w lista@ i grupach z setup/app.roleMappings
 * wg role_key/status_key każdego aktywnego (i zawieszonego/skreślonego — dostęp odbierany)
 * użytkownika, porównana z żywym stanem Google Directory API. Zamyka luki niezależnie od tego,
 * która ścieżka kodu zmieniła rolę (patrz Audyty/13.08_NAPRAWA_UPRAWNIEŃ_LISTA.MD).
 * Uruchamiany o 04:40 — po usersSyncRolesDaily (04:30), przed eventsSyncSheetDaily (04:45).
 */
export const usersReconcileWorkspaceGroupsDaily = onSchedule(
  {schedule: "40 4 * * *", timeZone: "Europe/Warsaw"},
  async () => {
    logger.info("usersReconcileWorkspaceGroupsDaily: start");
    const result = await (await loadRunTaskById())("users.reconcileWorkspaceGroups", {});
    logger.info("usersReconcileWorkspaceGroupsDaily: done", result as unknown as Record<string, unknown>);
  }
);

/**
 * SCHEDULER: Dzienny sync imprez z Google Sheets do Firestore.
 * Uruchamiany codziennie o 04:45 czasu warszawskiego (przed syncem kalendarza
 * o 05:00, żeby świeżo zatwierdzone imprezy trafiły do kalendarza tego samego ranka).
 *
 * Pobiera zatwierdzenia i korekty z arkusza oraz dopisuje do arkusza imprezy
 * zgłoszone w aplikacji, które nigdy do niego nie trafiły (backfill).
 * Bez tego crona zatwierdzenie w arkuszu docierało do aplikacji wyłącznie po
 * ręcznym uruchomieniu menu w arkuszu (audyt imprez, ryzyko I1).
 */
export const eventsSyncSheetDaily = onSchedule(
  {schedule: "45 4 * * *", timeZone: "Europe/Warsaw"},
  async () => {
    logger.info("eventsSyncSheetDaily: start");
    const result = await (await loadRunTaskById())("events.syncFromSheet", {});
    logger.info("eventsSyncSheetDaily: done", result as unknown as Record<string, unknown>);
  }
);

/**
 * SCHEDULER: Dzienny sync zatwierdzonych imprez z Firestore do Google Calendar.
 * Uruchamiany codziennie o 05:00 czasu warszawskiego.
 */
export const eventsSyncCalendarDaily = onSchedule(
  {schedule: "0 5 * * *", timeZone: "Europe/Warsaw"},
  async () => {
    logger.info("eventsSyncCalendarDaily: start");
    const result = await (await loadRunTaskById())("events.syncCalendar", {});
    logger.info("eventsSyncCalendarDaily: done", result as unknown as Record<string, unknown>);
  }
);

/**
 * SCHEDULER: Dzienne przypomnienia e-mail o zbliżających się imprezach.
 * Uruchamiany codziennie o 05:10 czasu warszawskiego (po eventsSyncCalendarDaily
 * o 05:00, żeby świeżo zsynchronizowane imprezy były już uwzględnione).
 * Liczba dni przed startem imprezy jest parametrem z arkusza SETUP
 * (setup/vars_members.vars.powiadomienie_imprezy) — patrz events_vars.ts.
 */
/**
 * SCHEDULER: Procedura Blach — maile na listę w terminach z SETUP, zestawienie dla Kapituły,
 * sprzątanie 14 dni po ogłoszeniu. Codziennie 06:15. Wyłączona, gdy blachy_procedura ≠ TRUE.
 */
export const blachyDaily = onSchedule(
  {schedule: "15 6 * * *", timeZone: "Europe/Warsaw"},
  async () => {
    const result = await (await loadRunTaskById())("blachy.daily", {});
    logger.info("blachyDaily: done", result as unknown as Record<string, unknown>);
  }
);

/**
 * SCHEDULER: Basen — decyzja o terminie 30 h przed (regulamin basenu § 5). Co godzinę,
 * bo moment decyzji zależy od godziny H1 (21:00 → 15:00 dnia poprzedniego).
 */
export const basenDecideHourly = onSchedule(
  {schedule: "0 * * * *", timeZone: "Europe/Warsaw"},
  async () => {
    const result = await (await loadRunTaskById())("basen.decideSessions", {});
    logger.info("basenDecideHourly: done", result as unknown as Record<string, unknown>);
  }
);

export const eventsNotifyUpcomingDaily = onSchedule(
  {schedule: "10 5 * * *", timeZone: "Europe/Warsaw"},
  async () => {
    logger.info("eventsNotifyUpcomingDaily: start");
    const result = await (await loadRunTaskById())("events.notifyUpcoming", {});
    logger.info("eventsNotifyUpcomingDaily: done", result as unknown as Record<string, unknown>);
  }
);

/**
 * SCHEDULER: Miesięczna przebudowa cache mapy aktywności km.
 * Uruchamiany 1. dnia każdego miesiąca o 03:30 czasu warszawskiego.
 */
export const kmRebuildMapMonthly = onSchedule(
  {schedule: "30 3 1 * *", timeZone: "Europe/Warsaw"},
  async () => {
    logger.info("kmRebuildMapMonthly: start");
    const result = await (await loadRunTaskById())("km.rebuildMapData", {});
    logger.info("kmRebuildMapMonthly: done", result as unknown as Record<string, unknown>);
  }
);

/**
 * SCHEDULER: Nagradza instruktorów basenowych 1h za każdy PRZEPROWADZONY (miniony)
 * termin — dopiero następnego dnia rano, nie przy samym zapisie. Uruchamiane
 * codziennie o 03:45 czasu warszawskiego, przed porannymi syncami godzinek/imprez.
 */
export const basenGrantInstructorRewardsDaily = onSchedule(
  {schedule: "45 3 * * *", timeZone: "Europe/Warsaw"},
  async () => {
    logger.info("basenGrantInstructorRewardsDaily: start");
    const result = await (await loadRunTaskById())("basen.grantInstructorRewards", {});
    logger.info("basenGrantInstructorRewardsDaily: done", result as unknown as Record<string, unknown>);
  }
);

/**
 * SCHEDULER: Dzienny sync godzinek z Google Sheets (zatwierdzenia, korekty pending,
 * backfill brakujących wierszy). Uruchamiany codziennie o 05:15 czasu warszawskiego.
 * Admin nadal może uruchomić sync ręcznie z menu arkusza — cron gwarantuje,
 * że zatwierdzenia docierają do użytkowników najpóźniej następnego ranka.
 */
export const godzinkiSyncDaily = onSchedule(
  {schedule: "15 5 * * *", timeZone: "Europe/Warsaw"},
  async () => {
    logger.info("godzinkiSyncDaily: start");
    const result = await (await loadRunTaskById())("godzinki.syncFromSheet", {});
    logger.info("godzinkiSyncDaily: done", result as unknown as Record<string, unknown>);
  }
);

/**
 * SCHEDULER: Dzienne czyszczenie arkusza Google "Godzinki" (usuwa wiersze starsze
 * niż setup/vars_godzinki.okres_do_archiwizacji_godzinek_dni — Firestore nietknięty).
 * Uruchamiany codziennie o 05:20 czasu warszawskiego, PO godzinkiSyncDaily (05:15),
 * żeby nie skasować wiersza w tym samym dniu, w którym sync mógłby go jeszcze korygować.
 */
export const godzinkiArchiveSheetDaily = onSchedule(
  {schedule: "20 5 * * *", timeZone: "Europe/Warsaw"},
  async () => {
    logger.info("godzinkiArchiveSheetDaily: start");
    const result = await (await loadRunTaskById())("godzinki.archiveSheetRows", {});
    logger.info("godzinkiArchiveSheetDaily: done", result as unknown as Record<string, unknown>);
  }
);

/**
 * SCHEDULER: Dzienny digest zaległych zatwierdzeń na adres zarządu.
 * Uruchamiany o 06:00 czasu warszawskiego — PO wszystkich porannych syncach
 * (imprezy 04:45, kalendarz 05:00, godzinki 05:15), więc mail dotyczy tylko
 * pozycji, których syncy nie rozwiązały. Brak zaległości → brak maila.
 */
export const adminPendingNotifyDaily = onSchedule(
  {schedule: "0 6 * * *", timeZone: "Europe/Warsaw"},
  async () => {
    logger.info("adminPendingNotifyDaily: start");
    const result = await (await loadRunTaskById())("admin.notifyPendingApprovals", {});
    logger.info("adminPendingNotifyDaily: done", result as unknown as Record<string, unknown>);
  }
);

// Ostatnia instrukcja pliku — domyka pomiar kosztu ładowania grafu modułów
// (patrz service/boot_timer.ts i nagłówek Server-Timing: boot;dur).
markModuleEvalDone();

/**
 * Całe API aplikacji w JEDNEJ funkcji (01.11.2026; poza appsScriptSync — sync z arkuszy).
 * Logi 18.10–01.11: 62% otwarć aplikacji trafiało na zimny start, 30% na DWA kolejne
 * (register/setup, potem ekran główny) — mediana 7,4 s czekania na serwer vs 0,5 s na ciepło.
 * Jedna funkcja = jeden zimny start na otwarcie, a ruch wszystkich użytkowników grzeje tę samą
 * instancję. Plan: DOCS/Sessions & TO DOs/01.11_konsolidacja_funkcji_PLAN.md
 */
const APP_ROUTES: Record<string, (req: any, res: any) => Promise<void>> = {
  "/api/register": registerUserRoute,
  "/api/setup": getSetupRoute,
  "/api/nickname-availability": checkNicknameAvailabilityRoute,
  "/api/godzinki": getGodzinkiRoute,
  "/api/events": getEventsRoute,
  "/api/events/interests": getEventInterestsRoute,
  "/api/admin/pending": getAdminPendingRoute,
  "/api/km/stats": kmMyStatsRoute,
  "/api/km/kursant-stats": getKursantStatsRoute,
  "/api/kurs/info": getKursInfoRoute,
  "/api/klub": getKlubInfoRoute,
  "/api/profile/notifications": notificationPrefsRoute,
  "/api/profile/data": profileDataRoute,
  "/api/dues": duesRoute,
  "/api/admin/dues": adminDuesRoute,
  "/api/test/role": testAccountSetRoleRoute,
  ...BASEN_ROUTES,
  // Etapy 2–4 (01.11.2026): sprzęt, km, akcje godzinek/imprez/profilu, zarząd, strony publiczne.
  "/api/admin/setup": adminPutSetupRoute,
  "/api/admin/reports/gear-rentals": getAdminGearRentalsRoute,
  "/api/admin/gear-reservations/cancel": adminCancelGearReservationRoute,
  "/api/admin/reports/gear-top-rentals": getAdminGearTopRentalsRoute,
  "/api/admin/reports/gear-damage": getAdminGearDamageReportsRoute,
  "/api/admin/reports/member-activity": getAdminMemberActivityRoute,
  "/api/admin/reports/member-dues": getAdminMemberDuesRoute,
  "/api/admin/reports/user-activity": getAdminUserActivityRoute,
  "/api/admin/events/sync-calendar": adminEventsSyncCalendarRoute,
  "/api/admin/approve": adminApproveRoute,
  "/api/admin/reject": adminRejectRoute,
  "/api/admin/gear-damage/resolve": resolveGearDamageReportRoute,
  "/api/gear/kayaks": getGearKayaksRoute,
  "/api/gear/items": getGearItemsRoute,
  "/api/gear/my-reservations": getGearMyReservationsRoute,
  "/api/gear/reservations/create": createGearReservationRoute,
  "/api/gear/reservations/create-bundle": createBundleGearReservationRoute,
  "/api/gear/items/availability": getGearItemAvailabilityRoute,
  "/api/gear/damage-report": submitGearDamageReportRoute,
  "/api/gear/reservations/update": updateGearReservationRoute,
  "/api/gear/reservations/update-items": updateBundleGearReservationItemsRoute,
  "/api/gear/reservations/cancel": cancelGearReservationRoute,
  "/api/gear/favorites": getGearFavoritesRoute,
  "/api/gear/favorites/toggle": gearFavoriteToggleRoute,
  "/api/gear/kayak-reservations": getKayakReservationsRoute,
  "/api/events/submit": submitEventRoute,
  "/api/events/interest/toggle": eventInterestToggleRoute,
  "/api/godzinki/submit": submitGodzinkiRoute,
  "/api/godzinki/purchase": purchaseGodzinkiRoute,
  "/api/km/log/add": kmAddLogRoute,
  "/api/km/log/update": kmAddLogRoute,
  "/api/km/log/delete": kmAddLogRoute,
  "/api/km/logs": kmMyLogsRoute,
  "/api/km/rankings": kmRankingsRoute,
  "/api/km/places": kmPlacesRoute,
  "/api/km/event-stats": kmEventStatsRoute,
  "/api/km/map-data": kmMapDataRoute,
  "/api/admin/km/places/merge": kmAdminMergePlacesRoute,
  "/api/user/weight": userWeightRoute,
  "/api/kurs/zgloszenie": kursZgloszenieRoute,
  "/api/admin/kurs/zgloszenia": adminKursZgloszeniaRoute,
  "/api/admin/kurs/zgloszenie": adminKursZgloszenieActionRoute,
  "/api/admin/blachy": adminBlachyRoute,
  "/api/public/site": publicSiteInfoRoute,
};

export const appApi = onRequest({invoker: "private"}, async (req, res) => {
  const path = String(req.path || "").replace(/\/+$/, "");
  // /api/blachy/** — blachyApi sam rozpoznaje akcję po ostatnim segmencie ścieżki.
  const route = APP_ROUTES[path] || (path.startsWith("/api/blachy/") ? blachyApiRoute : undefined);
  if (!route) {
    setCorsHeaders(req, res);
    res.status(404).json({error: "Not found"});
    return;
  }
  return route(req, res);
});
