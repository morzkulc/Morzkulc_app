import {logger} from "firebase-functions/v2";

/**
 * Checks whether a user's status_key is blocked according to setup/app.statusMappings.
 * A status is blocked when statusMappings[statusKey].blocksAccess === true.
 *
 * Returns false (not blocked) if setup/app does not exist or has no statusMappings.
 */
export async function isUserStatusBlocked(
  db: FirebaseFirestore.Firestore,
  statusKey: string
): Promise<boolean> {
  if (!statusKey) return false;

  const snap = await db.collection("setup").doc("app").get();
  if (!snap.exists) {
    logger.warn("isUserStatusBlocked: setup/app document does not exist", {statusKey});
    return false;
  }

  const data = snap.data() as any;
  const mappings = data?.statusMappings || {};
  const entry = mappings[statusKey];

  // Pozostałość po diagnostyce (pola `setupAppTopLevelKeys`, `blocksAccessType`)
  // usunięta 23.09.2026: funkcja ma 11 miejsc wywołania na ścieżkach zapisu
  // (rezerwacje, basen, godzinki, imprezy), więc każda operacja zapisu w aplikacji
  // serializowała pełną mapę statusów i zapisywała ją do Cloud Logging.
  // Log zawierał też status użytkownika przy każdej akcji (N19 z audytu 09.09).
  // logger.warn powyżej zostaje — brak setup/app to realny problem.
  return entry?.blocksAccess === true;
}
