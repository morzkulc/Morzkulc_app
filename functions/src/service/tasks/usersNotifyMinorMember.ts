import {ServiceTask} from "../types";
import {getAppVars, isTestAccount} from "../../modules/setup/app_vars";
import {normNullish} from "../../modules/shared/text_utils";
import {todayWarsawIso} from "../../modules/shared/date_range_utils";
import {fullName} from "../../modules/shared/user_display";
import {checkBirthDate} from "../../modules/users/birth_date";

export const MINOR_NOTIFY_TO = "zarzad@morzkulc.pl";

/** Treść maila do Zarządu — wydzielona do testów/podglądu. */
export function buildMinorMemberMail(u: any, age: number, adultAge: number, appUrl: string): {to: string; subject: string; body: string} {
  const name = fullName(u) || normNullish(u?.email);
  const dob = normNullish(u?.profile?.dateOfBirth);
  const [y, m, d] = dob.split("-");
  return {
    to: MINOR_NOTIFY_TO,
    subject: `Osoba niepełnoletnia w aplikacji — ${name} (${age} lat)`,
    body: [
      `${name} podał(a) w aplikacji datę urodzenia ${d}.${m}.${y} — ma ${age} lat (poniżej ${adultAge}).`,
      "",
      `E-mail: ${normNullish(u?.email)}`,
      `Telefon: ${normNullish(u?.profile?.phone) || "—"}`,
      ...(u?.memberId ? [`ID: ${u.memberId}`] : []),
      "",
      "Członkostwo osoby niepełnoletniej wymaga zgody Zarządu Klubu oraz pisemnej zgody przedstawiciela ustawowego.",
      "Konto działa normalnie — aplikacja niczego nie blokuje. Decyzję i zgodę opiekuna Zarząd załatwia sam.",
      "",
      appUrl,
    ].join("\n"),
  };
}

/**
 * users.notifyMinorMember — mail do Zarządu, gdy ktoś poda datę urodzenia oznaczającą wiek
 * od wiek_min_czlonka do wiek_pelnoletnosci − 1 (decyzja 04.11.2026). Raz na daną datę urodzenia.
 */
export const usersNotifyMinorMemberTask: ServiceTask<{uid: string}> = {
  id: "users.notifyMinorMember",
  description: "Użytkownicy: mail do Zarządu o osobie niepełnoletniej (16–17 lat) — wymaga zgody Zarządu i opiekuna.",

  validate: (payload) => {
    if (!payload?.uid) throw new Error("Missing uid");
  },

  run: async (payload, ctx) => {
    const ref = ctx.firestore.collection("users_active").doc(payload.uid);
    const u = (await ref.get()).data() as any;
    if (!u) return {ok: true, message: "Konto nie istnieje — pominięte."};
    if (await isTestAccount(ctx.firestore, normNullish(u?.email))) return {ok: true, message: "Konto testowe — pominięte."};
    const dob = normNullish(u?.profile?.dateOfBirth);
    const vars = await getAppVars(ctx.firestore);
    const c = checkBirthDate(dob, todayWarsawIso(), vars.ageLimits);
    if (c.code !== "minor" || c.age === null) return {ok: true, message: `Nie dotyczy (${c.code}).`};
    if (u?.service?.minorNotifiedDob === dob) return {ok: true, message: "Mail już wysłany dla tej daty."};
    const mail = buildMinorMemberMail(u, c.age, vars.ageLimits.adult, vars.appUrl);
    await ctx.workspace.sendGenericEmail(mail.to, mail.subject, mail.body);
    await ref.update({"service.minorNotifiedDob": dob, "service.minorNotifiedAt": new Date()});
    return {ok: true, message: "Mail do Zarządu wysłany."};
  },
};
