import * as admin from "firebase-admin";
import {randomUUID} from "crypto";
import {CATEGORY_COLLECTIONS} from "../bundle/gear_bundle_service";
import {normNullish} from "../../shared/text_utils";

const MAX_PHOTOS = 2;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

// 3 poziomy — wyłącznie informacyjne/priorytetowe dla panelu Zarządu (sortowanie,
// pilność). ŻADEN z nich nie blokuje rezerwacji ani nie zmienia dostępności sztuki —
// jedynym źródłem prawdy o sprawności sprzętu jest kolumna "Sprawny?" w arkuszu i
// sync (feedback użytkownika 07.09.2026: zgłoszenie z aplikacji + status z arkusza
// to były dwa niezależne źródła prawdy o tym samym — usunięte na rzecz jednego).
export type DamageSeverity = "usable" | "repair" | "dead";

export type DamagePhotoInput = {data: string; mimeType: string};

export type SubmitDamageReportInput = {
  uid: string;
  roleKey: string;
  reporterName: string;
  reporterEmail: string;
  category: string;
  itemId: string;
  severity: string; // niewalidowany input — normalizowane niżej w createDamageReport
  description: string;
  photos: DamagePhotoInput[];
};

type ServiceResult<T> =
  | {ok: true; data: T}
  | {ok: false; code: string; message: string};

export function isSupportedDamageCategory(category: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATEGORY_COLLECTIONS, normNullish(category).toLowerCase());
}

/**
 * Tworzy zgłoszenie uszkodzenia. Czysto informacyjne — nie zmienia dostępności
 * sztuki (patrz komentarz przy DamageSeverity). O tym, czy sztuka nadaje się do
 * rezerwacji, decyduje wyłącznie arkusz (kolumna "Sprawny?") + sync.
 */
export async function createDamageReport(
  db: FirebaseFirestore.Firestore,
  bucket: any,
  memberRoleKeys: string[],
  input: SubmitDamageReportInput
): Promise<ServiceResult<{reportId: string}>> {
  const roleKey = normNullish(input.roleKey);
  if (!memberRoleKeys.includes(roleKey)) {
    return {ok: false, code: "forbidden", message: "Rola nie uprawnia do zgłaszania uszkodzeń sprzętu."};
  }

  const category = normNullish(input.category).toLowerCase();
  const collection = CATEGORY_COLLECTIONS[category];
  if (!collection) {
    return {ok: false, code: "invalid_category", message: `Nieobsługiwana kategoria: ${category}`};
  }

  const itemId = normNullish(input.itemId);
  if (!itemId) {
    return {ok: false, code: "validation_failed", message: "Brak wskazanego przedmiotu."};
  }

  const description = normNullish(input.description);
  if (!description) {
    return {ok: false, code: "validation_failed", message: "Opis zgłoszenia jest wymagany."};
  }

  const itemRef = db.collection(collection).doc(itemId);
  const itemSnap = await itemRef.get();
  const itemData = (itemSnap.exists ? itemSnap.data() : null) as any;
  if (!itemSnap.exists || itemData?.isActive !== true || itemData?.gearScrapped === true) {
    return {ok: false, code: "item_not_found", message: `Nie znaleziono przedmiotu: ${itemId}`};
  }

  const severity: DamageSeverity =
    input.severity === "repair" ? "repair" :
      input.severity === "dead" ? "dead" :
        "usable";

  const number = normNullish(itemData?.number || itemId);
  const brand = normNullish(itemData?.brand);
  const model = normNullish(itemData?.model);
  const itemLabel = [brand, model].filter(Boolean).join(" ") || normNullish(itemData?.name) || number;

  const photosInput = Array.isArray(input.photos) ? input.photos.slice(0, MAX_PHOTOS) : [];

  const reportRef = db.collection("gear_damage_reports").doc();
  const reportId = reportRef.id;

  // Firebase "download token" (nie signed URL): zapisywany jako custom metadata
  // przy uploadzie przez Admin SDK, bez potrzeby uprawnienia iam.signBlob na
  // koncie serwisowym funkcji (tego projektu dotyczyły już wcześniej problemy
  // z IAM/invokerem — patrz feedback_function_invoker w pamięci). To ten sam
  // mechanizm, którego Firebase Console używa dla ręcznie wgrywanych zdjęć
  // sprzętu odczytywanych dziś przez klienta (public/core/firebase_client.js).
  const photoUrls: string[] = [];
  let photoIndex = 0;
  for (const photo of photosInput) {
    photoIndex++;
    const raw = normNullish(photo?.data);
    const base64 = raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw;
    if (!base64) continue;

    const buffer = Buffer.from(base64, "base64");
    if (buffer.length === 0) continue;
    if (buffer.length > MAX_PHOTO_BYTES) {
      return {ok: false, code: "photo_too_large", message: "Zdjęcie jest za duże (limit 3 MB) — spróbuj ponownie, aplikacja powinna je skompresować."};
    }

    const mimeType = normNullish(photo?.mimeType) || "image/jpeg";
    const ext = mimeType.includes("png") ? "png" : "jpg";
    const path = `gear_damage_reports/${category}/${itemId}/${reportId}/${photoIndex}.${ext}`;
    const token = randomUUID();
    const file = bucket.file(path);
    await file.save(buffer, {
      metadata: {
        contentType: mimeType,
        metadata: {firebaseStorageDownloadTokens: token},
      },
    });
    photoUrls.push(`https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`);
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  await reportRef.set({
    id: reportId,
    category,
    itemId,
    itemNumber: number,
    itemLabel,
    severity,
    description,
    photoUrls,
    reporterUid: input.uid,
    reporterName: normNullish(input.reporterName) || normNullish(input.reporterEmail) || input.uid,
    reporterEmail: normNullish(input.reporterEmail),
    status: "open",
    createdAt: now,
    resolvedAt: null,
    resolvedByUid: null,
    resolvedByName: null,
  });

  return {ok: true, data: {reportId}};
}

/**
 * Oznacza zgłoszenie jako rozwiązane (usuwa je z listy oczekujących w panelu
 * Zarządu). Nie dotyka dokumentu sprzętu — dostępność sztuki reguluje wyłącznie
 * arkusz + sync, więc nie ma tu nic do "odblokowania".
 */
export async function resolveDamageReport(
  db: FirebaseFirestore.Firestore,
  input: {reportId: string; resolvedByUid: string; resolvedByName: string}
): Promise<ServiceResult<Record<string, never>>> {
  const reportId = normNullish(input.reportId);
  if (!reportId) {
    return {ok: false, code: "validation_failed", message: "Brak reportId"};
  }

  const reportRef = db.collection("gear_damage_reports").doc(reportId);
  const reportSnap = await reportRef.get();
  if (!reportSnap.exists) {
    return {ok: false, code: "not_found", message: "Zgłoszenie nie znalezione"};
  }
  const report = reportSnap.data() as any;

  if (report?.status !== "resolved") {
    await reportRef.update({
      status: "resolved",
      resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
      resolvedByUid: input.resolvedByUid,
      resolvedByName: normNullish(input.resolvedByName) || input.resolvedByUid,
    });
  }

  return {ok: true, data: {}};
}
