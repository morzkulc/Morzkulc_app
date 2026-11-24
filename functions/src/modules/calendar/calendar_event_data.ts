import {CalendarEventData} from "../../service/providers/googleCalendarProvider";
import {norm} from "../shared/text_utils";
import {getAppVars} from "../setup/app_vars";
import {getCachedDoc} from "../setup/doc_cache";

/**
 * Wspólny opis wydarzenia w kalendarzu Google (events.syncCalendar i events.syncFromSheet
 * budowały go osobno, 1:1). Od 24.11.2026 na końcu opisu link do imprezy w aplikacji.
 */

/** Id modułu Imprezy z setup/app.modules — ta sama reguła co resolveModuleType we froncie (type, potem etykieta). */
export function resolveEventsModuleId(setupApp: any): string {
  const modules = setupApp?.modules && typeof setupApp.modules === "object" ? setupApp.modules : {};
  for (const [id, cfg] of Object.entries<any>(modules)) {
    if (cfg?.enabled === false) continue;
    const type = norm(cfg?.type).toLowerCase();
    const label = norm(cfg?.label).toLowerCase();
    if (type === "imprezy" || (!type && label === "imprezy")) return id;
  }
  return "";
}

/** Link do konkretnej imprezy w aplikacji: <appUrl>#/<modułImprez>/ev-<eventId> (trasa w impreza_module.js). */
export function eventAppLink(appUrl: string, moduleId: string, eventId: string): string {
  const base = norm(appUrl).replace(/\/+$/, "");
  if (!base || !moduleId || !eventId) return "";
  return `${base}/#/${moduleId}/ev-${encodeURIComponent(eventId)}`;
}

/** Baza linku (appUrl z SETUP + id modułu Imprezy) — jeden odczyt na przebieg syncu. */
export async function loadEventLinkBase(db: FirebaseFirestore.Firestore): Promise<{appUrl: string; moduleId: string}> {
  const [vars, setupSnap] = await Promise.all([getAppVars(db), getCachedDoc(db, "setup", "app")]);
  return {appUrl: vars.appUrl, moduleId: resolveEventsModuleId(setupSnap.exists ? setupSnap.data() : null)};
}

export function buildCalendarEventData(
  eventId: string,
  data: {name?: any; startDate?: any; endDate?: any; description?: any; contact?: any; link?: any; location?: any},
  linkBase: {appUrl: string; moduleId: string}
): CalendarEventData {
  const parts: string[] = [];
  const description = norm(data?.description);
  const contact = norm(data?.contact);
  const link = norm(data?.link);
  if (description) parts.push(description);
  if (contact) parts.push(`Kontakt: ${contact}`);
  if (link) parts.push(`Link: ${link}`);
  const appLink = eventAppLink(linkBase.appUrl, linkBase.moduleId, eventId);
  if (appLink) parts.push(`Impreza w aplikacji: ${appLink}`);
  return {
    summary: norm(data?.name),
    description: parts.join("\n"),
    location: norm(data?.location),
    startDate: norm(data?.startDate),
    endDate: norm(data?.endDate),
  };
}

/**
 * „Dodaj do kalendarza” — jeden przycisk (decyzja 24.11.2026): Google Calendar otwiera
 * okno dodania publicznego kalendarza klubowego do konta zalogowanego użytkownika.
 */
export function calendarAddUrl(calendarId: string): string {
  const id = norm(calendarId);
  return id ? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(id)}` : "";
}
