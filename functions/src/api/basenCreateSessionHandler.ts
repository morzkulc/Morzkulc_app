import type {Request, Response} from "express";
import {createSession, getBasenVars, resolveBasenAdminGrant, ReservedSpotsInput, ClientError} from "../modules/basen/basen_service";

type Deps = {
  db: FirebaseFirestore.Firestore;
  sendPreflight: (req: Request, res: Response) => boolean;
  requireAllowedHost: (req: Request, res: Response) => boolean;
  setCorsHeaders: (req: Request, res: Response) => void;
  corsHandler: (req: Request, res: Response, next: () => void) => void;
  requireIdToken: (req: Request) => Promise<{error: string} | {decoded: any}>;
  adminRoleKeys: string[];
};

/** Liczba miejsc na godzinę z formularza; brak → domyślna z SETUP. */
const MAX_CAPACITY = 60;
function readCapacity(raw: any, label: string, fallback: number): {ok: true; value: number} | {ok: false; error: string} {
  if (raw === undefined || raw === null || raw === "") return {ok: true, value: fallback};
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CAPACITY) {
    return {ok: false, error: `${label}: liczba miejsc musi być liczbą całkowitą od 1 do ${MAX_CAPACITY}.`};
  }
  return {ok: true, value: n};
}

function readReserved(raw: any, label: string, maxCount: number): {ok: true; value?: ReservedSpotsInput} | {ok: false; error: string} {
  if (!raw || typeof raw !== "object" || !(Number(raw.count) > 0)) return {ok: true, value: undefined};

  const count = Math.floor(Number(raw.count));
  if (!Number.isFinite(count) || count < 1 || count > maxCount) {
    return {ok: false, error: `${label}: liczba zarezerwowanych miejsc musi być między 1 a ${maxCount}.`};
  }

  const restrictedToKursant = raw.restrictedToKursant === true;
  const rawLabel = String(raw.label || "").trim().slice(0, 100);
  return {
    ok: true,
    value: {count, restrictedToKursant, label: !restrictedToKursant && rawLabel ? rawLabel : undefined},
  };
}

export async function handleBasenCreateSession(req: Request, res: Response, deps: Deps): Promise<void> {
  if (deps.sendPreflight(req, res)) return;
  if (!deps.requireAllowedHost(req, res)) return;
  deps.setCorsHeaders(req, res);

  deps.corsHandler(req, res, async () => {
    if (req.method !== "POST") {
      res.status(405).json({error: "Method not allowed"});
      return;
    }

    try {
      const tokenCheck = await deps.requireIdToken(req);
      if ("error" in tokenCheck) {
        res.status(401).json({error: tokenCheck.error});
        return;
      }

      const uid = tokenCheck.decoded.uid;

      const adminSnap = await deps.db.collection("users_active").doc(uid).get();
      if (!adminSnap.exists) {
        res.status(403).json({error: "User not found"});
        return;
      }

      const adminData = adminSnap.data() as any;
      const adminRoleKey = String(adminData?.role_key || "");
      const adminEmail = String(adminData?.email || "");
      if (!deps.adminRoleKeys.includes(adminRoleKey) && !(await resolveBasenAdminGrant(deps.db, adminEmail))) {
        res.status(403).json({error: "Brak uprawnień. Wymagana rola: zarząd/KR lub opiekun basenowy."});
        return;
      }

      const body = req.body || {};
      const date = String(body.date || "").trim();
      const notes = String(body.notes || "").trim();

      if (!date) {
        res.status(400).json({error: "Wymagane pole: data."});
        return;
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.status(400).json({error: "Nieprawidłowy format daty (YYYY-MM-DD)."});
        return;
      }

      const vars = await getBasenVars(deps.db);

      const h1Cap = readCapacity(body.h1Capacity, "H1", vars.basen_limit_uczestnikow);
      if (!h1Cap.ok) {
        res.status(400).json({error: h1Cap.error});
        return;
      }
      const h2Cap = readCapacity(body.h2Capacity, "H2", vars.basen_limit_uczestnikow);
      if (!h2Cap.ok) {
        res.status(400).json({error: h2Cap.error});
        return;
      }

      const h1Result = readReserved(body.h1Reserved, "H1", h1Cap.value);
      if (!h1Result.ok) {
        res.status(400).json({error: h1Result.error});
        return;
      }
      const h2Result = readReserved(body.h2Reserved, "H2", h2Cap.value);
      if (!h2Result.ok) {
        res.status(400).json({error: h2Result.error});
        return;
      }

      const saunaEnabled = body.saunaEnabled === true;

      const sessionId = await createSession(deps.db, {
        date,
        saunaEnabled,
        h1Reserved: h1Result.value,
        h2Reserved: h2Result.value,
        h1Capacity: h1Cap.value,
        h2Capacity: h2Cap.value,
        notes,
        createdBy: uid,
        vars,
      });

      res.status(200).json({ok: true, sessionId});
    } catch (err) {
      const e = err as {message?: string};
      const msg = e?.message || String(err);
      res.status(err instanceof ClientError ? 400 : 500).json({error: msg});
    }
  });
}
