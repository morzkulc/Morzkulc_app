/**
 * kmAddLogHandler.ts
 *
 * POST /kmAddLog
 *
 * Dodaje nowy wpis aktywności do modułu Kilometrówka.
 * Oblicza punkty ON WRITE po stronie backendu.
 * Aktualizuje agregaty użytkownika (km_user_stats).
 *
 * Body:
 *   date: string               — "YYYY-MM-DD", wymagane, nie z przyszłości
 *   waterType: string          — enum: mountains|lowlands|sea|track|pool (track = tor / playspot; stare "playspot" → track)
 *   placeName: string          — nazwa akwenu (canonical lub raw), wymagane
 *   placeNameRaw?: string      — raw input, jeśli różny od placeName
 *   placeId?: string           — ID z km_places (jeśli wybrano z podpowiedzi)
 *   km: number                 — kilometry, > 0, <= 9999
 *   hoursOnWater: number       — godziny na wodzie, >= 0, wymagane (0 jeśli nie mierzono)
 *   difficultyScale?: string   — "WW"|"U" — wymagane dla mountains/lowlands, null dla reszty
 *   difficulty?: string        — "WW3", "U2", itp. — wymagane dla mountains/lowlands (poza source=kursant_form)
 *   capsizeRolls?: {kabina, rolka, dziubek} — wywrotolotek (całkowite, >= 0)
 *   sectionDescription?: string
 *   note?: string
 *   lat?, lng?: number         — lokalizacja; WYMAGANA, chyba że miejsce w km_places ma współrzędne
 *                                (inaczej 400 location_required)
 *   source?: "kursant_form"    — formularz kursanta: zwolniony z wymogu lokalizacji
 */

import type {Request, Response} from "express";
import * as admin from "firebase-admin";
import {getKmVars} from "../modules/km/km_vars";
import {addKmLog} from "../modules/km/km_log_service";
import {upsertKmPlace} from "../modules/km/km_places_service";
import {normNullish} from "../modules/shared/text_utils";

type TokenCheck =
  | {error: string}
  | {decoded: {uid: string; email?: string; name?: string}};

export type KmAddLogDeps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: any;
  requireIdToken: (req: Request) => Promise<TokenCheck>;
  memberRoleKeys: string[];
};

const VALID_WATER_TYPES = new Set([
  "mountains", "lowlands", "sea", "track", "pool",
]);

const WATER_TYPES_WITH_DIFFICULTY = new Set(["mountains", "lowlands"]);
// Tor / playspot i basen — kilometry nie mają sensu; zapisywane zawsze jako 0 (także ze starych klientów).
const NO_KM_WATER_TYPES = new Set(["track", "pool"]);

const VALID_DIFFICULTY_WW = new Set(["WW1", "WW2", "WW3", "WW4", "WW5"]);
const VALID_DIFFICULTY_U = new Set(["U1", "U2", "U3"]);

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toSafeInt(v: any): number {
  const n = parseInt(String(v || "0"), 10);
  return Number.isNaN(n) ? 0 : Math.max(0, n);
}

function toSafeFloat(v: any): number {
  const n = parseFloat(String(v || "0"));
  return Number.isNaN(n) ? 0 : Math.max(0, n);
}

export async function handleKmAddLog(
  req: Request,
  res: Response,
  deps: KmAddLogDeps
): Promise<void> {
  if (deps.sendPreflight(req, res)) return;
  if (!deps.requireAllowedHost(req, res)) return;
  deps.setCorsHeaders(req, res);

  deps.corsHandler(req, res, async () => {
    if (req.method !== "POST") {
      res.status(405).json({error: "Method not allowed"});
      return;
    }

    try {
      // 1. Token
      const tokenCheck = await deps.requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }
      const uid = tokenCheck.decoded.uid;

      // 2. Pobierz profil użytkownika dla snapshotu
      const userSnap = await deps.db.collection("users_active").doc(uid).get();
      if (!userSnap.exists) {
        res.status(403).json({error: "Użytkownik nie znaleziony."});
        return;
      }
      const userData = userSnap.data() as any;
      const roleKey = normNullish(userData?.role_key);
      if (!deps.memberRoleKeys.includes(roleKey)) {
        res.status(403).json({ok: false, code: "forbidden", error: "Dodawanie wpisów do kilometrówki wymaga roli Kandydat lub Członek."});
        return;
      }
      const profile = userData?.profile || {};
      const userSnapshot = {
        displayName: normNullish(userData?.profile?.firstName + " " + userData?.profile?.lastName) ||
          normNullish(tokenCheck.decoded.name) ||
          normNullish(tokenCheck.decoded.email),
        nickname: normNullish(profile?.nickname),
        email: normNullish(userData?.email || tokenCheck.decoded.email),
      };

      // 3. Walidacja body
      const body = (req.body || {}) as any;
      const date = normNullish(body.date);
      // Od 13.10.2026 tor i playspot to jeden typ „track” — starsze klienty mogą jeszcze wysłać „playspot”.
      const waterTypeRaw = normNullish(body.waterType);
      const waterType = waterTypeRaw === "playspot" ? "track" : waterTypeRaw;
      const placeName = normNullish(body.placeName).slice(0, 200);
      const placeNameRaw = normNullish(body.placeNameRaw || body.placeName).slice(0, 200);
      const placeId = normNullish(body.placeId) || undefined;
      const kmRaw = toSafeFloat(body.km);
      const hoursOnWaterRaw = body.hoursOnWater;
      const hoursOnWater = hoursOnWaterRaw != null ? toSafeFloat(hoursOnWaterRaw) : null;
      const difficultyScale = normNullish(body.difficultyScale) || null;
      const difficulty = normNullish(body.difficulty) || null;
      const sectionDescription = normNullish(body.sectionDescription).slice(0, 500) || undefined;
      const note = normNullish(body.note).slice(0, 1000) || undefined;
      const eventId = normNullish(body.eventId).slice(0, 128) || undefined;
      const eventName = normNullish(body.eventName).slice(0, 200) || undefined;

      const capsizeRolls = {
        kabina: toSafeInt(body.capsizeRolls?.kabina),
        rolka: toSafeInt(body.capsizeRolls?.rolka),
        dziubek: toSafeInt(body.capsizeRolls?.dziubek),
      };

      const lat = body.lat != null ? parseFloat(String(body.lat)) : undefined;
      const lng = body.lng != null ? parseFloat(String(body.lng)) : undefined;

      // Walidacja date
      if (!isIsoDate(date)) {
        res.status(400).json({ok: false, code: "validation_failed", message: "Nieprawidłowy format daty (wymagane YYYY-MM-DD)."});
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      if (date > today) {
        res.status(400).json({ok: false, code: "validation_failed", message: "Data nie może być z przyszłości."});
        return;
      }

      // Walidacja waterType
      if (!VALID_WATER_TYPES.has(waterType)) {
        res.status(400).json({ok: false, code: "validation_failed", message: "Nieprawidłowy typ akwenu."});
        return;
      }

      // Walidacja placeName
      if (!placeName) {
        res.status(400).json({ok: false, code: "validation_failed", message: "Nazwa akwenu jest wymagana."});
        return;
      }

      // Walidacja km — wartość 0 jest dozwolona (np. trening bez przebytej trasy)
      if (kmRaw < 0 || kmRaw > 9999) {
        res.status(400).json({ok: false, code: "validation_failed", message: "Kilometry nie mogą być ujemne ani większe niż 9999."});
        return;
      }

      // Walidacja hoursOnWater — wymagane, może być 0
      if (hoursOnWater === null || isNaN(hoursOnWater) || hoursOnWater < 0 || hoursOnWater > 99) {
        res.status(400).json({ok: false, code: "validation_failed", message: "Godziny na wodzie są wymagane (wpisz 0 jeśli nie mierzono). Wartość od 0 do 99."});
        return;
      }

      // Walidacja lat/lng
      if (lat != null && (isNaN(lat) || lat < -90 || lat > 90)) {
        res.status(400).json({ok: false, code: "validation_failed", message: "Nieprawidłowa szerokość geograficzna (lat)."});
        return;
      }
      if (lng != null && (isNaN(lng) || lng < -180 || lng > 180)) {
        res.status(400).json({ok: false, code: "validation_failed", message: "Nieprawidłowa długość geograficzna (lng)."});
        return;
      }

      // Walidacja trudności — logika warunkowa
      if (WATER_TYPES_WITH_DIFFICULTY.has(waterType)) {
        // Wymagana (od 12.10.2026) — poza formularzem kursanta (wpis kursowy bez skali).
        if (!difficulty && normNullish(body.source) !== "kursant_form") {
          res.status(400).json({ok: false, code: "difficulty_required", message: waterType === "mountains" ? "Wybierz trudność (WW1–WW5)." : "Wybierz uciążliwość (U1–U3)."});
          return;
        }
        // mountains: tylko WW, lowlands: tylko U
        if (waterType === "mountains") {
          if (difficultyScale && difficultyScale !== "WW") {
            res.status(400).json({ok: false, code: "validation_failed", message: "Dla gór wymagana skala WW."});
            return;
          }
          if (difficultyScale === "WW" && difficulty && !VALID_DIFFICULTY_WW.has(difficulty)) {
            res.status(400).json({ok: false, code: "validation_failed", message: "Nieprawidłowy poziom WW (WW1–WW5)."});
            return;
          }
        }
        if (waterType === "lowlands") {
          if (difficultyScale && difficultyScale !== "U") {
            res.status(400).json({ok: false, code: "validation_failed", message: "Dla nizin wymagana skala U."});
            return;
          }
          if (difficultyScale === "U" && difficulty && !VALID_DIFFICULTY_U.has(difficulty)) {
            res.status(400).json({ok: false, code: "validation_failed", message: "Nieprawidłowy poziom U (U1–U3)."});
            return;
          }
        }
      } else {
        // Dla sea/track/pool — skala trudności nie może być podana
        if (difficulty) {
          res.status(400).json({ok: false, code: "validation_failed", message: "Skala trudności nie dotyczy wybranego typu akwenu."});
          return;
        }
      }

      // 4. Lokalizacja — WYMAGANA (od 12.10.2026): z wpisu (GPS/mapa/podpowiedź) albo ze słownika
      // km_places (po placeId lub dokładnej nazwie). Bez niej wpis nie trafiłby na mapę.
      // Ustalane PRZED upsertem, żeby odrzucony wpis nie dodał do słownika miejsca bez współrzędnych.
      // Wyjątek: formularz kursanta (akwen = nazwa imprezy kursowej, bez lokalizacji).
      const isKursantForm = normNullish(body.source) === "kursant_form";
      let mapLat = lat;
      let mapLng = lng;
      if (mapLat == null || mapLng == null) {
        mapLat = undefined;
        mapLng = undefined;
        const placeDoc = placeId ?
          await deps.db.collection("km_places").doc(placeId).get() :
          (await deps.db.collection("km_places").where("name", "==", placeName).limit(1).get()).docs[0];
        const place = placeDoc?.exists ? (placeDoc.data() as any) : null;
        if (typeof place?.lat === "number" && typeof place?.lng === "number") {
          mapLat = place.lat;
          mapLng = place.lng;
        }
      }
      if ((mapLat == null || mapLng == null) && !isKursantForm) {
        res.status(400).json({
          ok: false,
          code: "location_required",
          message: "Podaj lokalizację: wybierz miejsce z podpowiedzi, użyj GPS albo zaznacz na mapie.",
        });
        return;
      }

      // 5. Pobierz konfigurację punktacji
      const vars = await getKmVars(deps.db);

      // 5b. Upsert place w słowniku — nowe miejsce trafia do słownika od razu ze współrzędnymi;
      // istniejącemu bez współrzędnych upsert je uzupełnia.
      let resolvedPlaceId: string | undefined;
      try {
        resolvedPlaceId = await upsertKmPlace(deps.db, {
          placeId,
          name: placeName,
          waterType,
          lat: mapLat,
          lng: mapLng,
        });
      } catch {
        // Błąd słownika nie blokuje zapisu wpisu
      }

      // 6. Zapisz wpis
      const logId = await addKmLog(deps.db, {
        uid,
        userSnapshot,
        date,
        waterType: waterType as any,
        placeName,
        placeNameRaw,
        placeId: resolvedPlaceId,
        lat: mapLat,
        lng: mapLng,
        sectionDescription,
        km: NO_KM_WATER_TYPES.has(waterType) ? 0 : kmRaw,
        hoursOnWater: hoursOnWater as number,
        difficultyScale: difficultyScale as any,
        difficulty,
        capsizeRolls,
        note,
        eventId,
        eventName,
      }, vars);

      // 7. Wpis z lokalizacją → odśwież cache mapy od razu (wcześniej tylko raz w miesiącu,
      // więc nowe wpisy czekały na mapę do 1. dnia następnego miesiąca).
      if (mapLat != null && mapLng != null) {
        try {
          const jobRef = deps.db.collection("service_jobs").doc();
          await jobRef.set({
            id: jobRef.id,
            taskId: "km.rebuildMapData",
            payload: {},
            status: "queued",
            attempts: 0,
            // Bez nextRunAt fallback dzienny nie podejmie joba, gdyby trigger zawiódł.
            nextRunAt: admin.firestore.FieldValue.serverTimestamp(),
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch {
          // Mapę i tak przebuduje scheduler miesięczny
        }
      }

      res.status(200).json({ok: true, logId});
    } catch (err: any) {
      res.status(500).json({error: "Server error", message: err?.message || String(err)});
    }
  });
}
