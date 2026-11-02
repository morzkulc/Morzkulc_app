import * as admin from "firebase-admin";
import {ServiceTask, ServiceTaskContext} from "../types";
import {GoogleSheetsProvider} from "../providers/googleSheetsProvider";
import {getServiceConfig} from "../service_config";
import {normNullish} from "../../modules/shared/text_utils";
import {normalizeSheetHeader} from "../../modules/kurs/kurs_zgloszenia";
import {getAppVars, isTestAccount} from "../../modules/setup/app_vars";
import {resolveFunctionRoleMailbox} from "../../modules/setup/function_roles_service";
import {todayWarsawIso} from "../../modules/shared/date_range_utils";
import {fullName, isRegistered} from "../../modules/shared/user_display";
import {MEMBER_ROLE_KEYS, effectivePaidUntilIso} from "../../modules/users/member_standing";
import {
  DUES_ORDERS, DuesOrder, computeDuesStatus, formatDatePl, formatPln,
} from "../../modules/dues/dues_service";

/**
 * Taski składek (plan: DOCS/Sessions & TO DOs/01.11_skladki_zglaszanie_PLAN.md):
 *  - dues.writeBack     — po potwierdzeniu skarbnika: data do kolumny „Składki" w arkuszu → baza → mail,
 *  - dues.notifyOrder   — mail do członka: zgłoszenie (dane przelewu) / odrzucenie / zaksięgowanie,
 *  - dues.sendReminder  — przypomnienie o zaległości wysłane ręcznie przez skarbnika,
 *  - dues.daily         — alert do skarbnika o zgłoszeniach czekających > N dni + przypomnienia
 *                         dla osób, które same je włączyły (profile.notifications.duesReminder).
 */

const KIND_LABEL = {skladka: "Składka członkowska", wpisowe: "Wpisowe"};

function orderLabel(o: Pick<DuesOrder, "kind" | "semesters">): string {
  return o.kind === "wpisowe" ? "Wpisowe (2 semestry)" : `Składka członkowska — ${o.semesters} ${o.semesters === 1 ? "semestr" : o.semesters < 5 ? "semestry" : "semestrów"}`;
}

function accountLines(vars: {clubAccount: string; clubBank: string}): string {
  return vars.clubAccount ? `Konto: ${vars.clubAccount}${vars.clubBank ? ` (${vars.clubBank})` : ""}` : "Konto: podane w aplikacji (Profil → Składki)";
}

// ─── dues.writeBack ─────────────────────────────────────────────────────────

type WriteBackPayload = {orderId: string};

export const duesWriteBackTask: ServiceTask<WriteBackPayload> = {
  id: "dues.writeBack",
  description: "Składki: po potwierdzeniu wpłaty wpisuje datę do arkusza członków, potem do bazy i wysyła mail.",

  validate: (payload) => {
    if (!payload?.orderId) throw new Error("Missing orderId");
  },

  run: async (payload, ctx) => {
    const ref = ctx.firestore.collection(DUES_ORDERS).doc(payload.orderId);
    const o = (await ref.get()).data() as DuesOrder | undefined;
    if (!o || o.status !== "approved" || !o.writeBack) return {ok: true, message: "Brak zatwierdzonego zgłoszenia — pominięte."};
    if (o.writeBack.status !== "pending") return {ok: true, message: `Zapis już obsłużony (${o.writeBack.status}).`};
    const {from, to} = o.writeBack;

    const cfg = getServiceConfig();
    const sheetCfg = {spreadsheetId: cfg.sheets.membersSpreadsheetId, tabName: cfg.sheets.membersTabName};
    const sheets = new GoogleSheetsProvider(cfg.workspace.delegatedSubject);
    const table = await sheets.readTableAsObjects(sheetCfg);
    const header = (norm: string) => table.headers.find((h) => normalizeSheetHeader(h) === norm) || "";
    const idH = header("id");
    const duesH = header("skladki");
    const feeH = table.headers.find((h) => normalizeSheetHeader(h).startsWith("wpisowe")) || "";
    if (!idH || !duesH || (o.kind === "wpisowe" && !feeH)) {
      return {ok: false, message: "Arkusz członków: brak kolumny ID / Składki / Wpisowe (mm.yyyy)."};
    }
    const row = table.rows.find((r) => normNullish(r[idH]) === String(o.memberId));
    if (!row) return {ok: false, message: `Arkusz członków: brak wiersza z ID ${o.memberId}.`};

    const current = effectivePaidUntilIso(row[duesH]);
    const month = todayWarsawIso().slice(0, 7); // "YYYY-MM" — miesiąc wpłaty wpisowego
    if (current !== to) {
      if (current !== from) {
        // Ktoś zmienił datę w arkuszu po potwierdzeniu — nie nadpisujemy, decyzja należy do skarbnika.
        const message = `W arkuszu jest data ${current || "(puste)"}, a w chwili potwierdzenia była ${from || "(puste)"}. ` +
          `Nowa data ${to} nie została wpisana — sprawdź wiersz ID ${o.memberId} i wpisz ją ręcznie.`;
        await ref.update({"writeBack.status": "conflict", "writeBack.message": message, "updatedAt": admin.firestore.FieldValue.serverTimestamp()});
        ctx.logger.warn("dues.writeBack: konflikt z arkuszem", {orderId: o.id, memberId: o.memberId, current, from, to});
        return {ok: true, message};
      }
      if (ctx.dryRun) return {ok: true, message: `[DRY RUN] ${from} → ${to}`};
      const rowNumber = Number((row as any)._rowNumber);
      // „Składki” to prawdziwe daty w arkuszu → USER_ENTERED (zostaje formatem daty kolumny).
      await sheets.writeRowCells(sheetCfg, rowNumber, {[duesH]: to}, "USER_ENTERED");
      // „Wpisowe (mm.yyyy)” — tekst MM.RRRR (RAW, żeby arkusz nie zamienił go na inną datę).
      if (o.kind === "wpisowe") await sheets.writeRowCells(sheetCfg, rowNumber, {[feeH]: `${month.slice(5)}.${month.slice(0, 4)}`});
    }

    // Arkusz ma nową datę → baza tę samą wartość (sync nocny niczego nie zmieni).
    const userPatch: Record<string, any> = {"admin.contributions": to, "updatedAt": admin.firestore.FieldValue.serverTimestamp()};
    if (o.kind === "wpisowe") {
      userPatch["admin.entryFee"] = `${month.slice(5)}.${month.slice(0, 4)}`;
      userPatch["admin.entryFeePaidAt"] = month;
    }
    await ctx.firestore.collection("users_active").doc(o.uid).update(userPatch);
    const now = admin.firestore.FieldValue.serverTimestamp();
    await ref.update({"writeBack.status": "done", "writeBack.doneAt": now, "updatedAt": now});
    const jobRef = ctx.firestore.collection("service_jobs").doc();
    await jobRef.set({id: jobRef.id, taskId: "dues.notifyOrder", payload: {orderId: o.id, kind: "booked"}, status: "queued", attempts: 0, createdAt: now, updatedAt: now});
    ctx.logger.info("dues.writeBack: done", {orderId: o.id, memberId: o.memberId, from, to});
    return {ok: true, message: `ID ${o.memberId}: ${from || "(puste)"} → ${to}`};
  },
};

// ─── dues.notifyOrder ───────────────────────────────────────────────────────

type NotifyPayload = {orderId: string; kind: "created" | "rejected" | "booked"};

export const duesNotifyOrderTask: ServiceTask<NotifyPayload> = {
  id: "dues.notifyOrder",
  description: "Składki: mail do członka (zgłoszenie z danymi przelewu / odrzucenie / zaksięgowanie).",

  validate: (payload) => {
    if (!payload?.orderId) throw new Error("Missing orderId");
    if (!["created", "rejected", "booked"].includes(payload.kind)) throw new Error("Invalid kind");
  },

  run: async (payload, ctx) => {
    const ref = ctx.firestore.collection(DUES_ORDERS).doc(payload.orderId);
    const o = (await ref.get()).data() as (DuesOrder & Record<string, any>) | undefined;
    if (!o) return {ok: true, message: "Zgłoszenie nie istnieje — mail pominięty."};
    const mark = `notified_${payload.kind}_at`;
    if (o[mark]) return {ok: true, message: "Mail już wysłany."};
    if (!o.userEmail.includes("@")) return {ok: false, message: "Brak adresu e-mail."};

    const vars = await getAppVars(ctx.firestore);
    const label = orderLabel(o);
    let subject: string;
    let lines: string[];
    if (payload.kind === "created") {
      subject = `${KIND_LABEL[o.kind]} — dane do przelewu`;
      lines = [
        "Dziękujemy za zgłoszenie wpłaty.",
        "",
        `Za: ${label}`,
        `Kwota: ${formatPln(o.amountPln)}`,
        accountLines(vars),
        `Tytuł przelewu: ${o.transferTitle}`,
        "",
        "Skarbnik potwierdzi wpłatę po jej zaksięgowaniu — dostaniesz wtedy maila z nową datą.",
        "Niepotwierdzone zgłoszenie możesz anulować w aplikacji (Profil → Składki).",
      ];
    } else if (payload.kind === "rejected") {
      subject = `${KIND_LABEL[o.kind]} — zgłoszenie odrzucone`;
      lines = [
        "Skarbnik odrzucił zgłoszenie wpłaty.",
        "",
        `Za: ${label}`,
        `Kwota: ${formatPln(o.amountPln)}`,
        `Powód: ${normNullish(o.rejectReason) || "—"}`,
        "",
        "Jeśli to pomyłka, odpowiedz na tego maila albo napisz do skarbnika (skarbnik@morzkulc.pl).",
      ];
    } else {
      subject = `${KIND_LABEL[o.kind]} zaksięgowan${o.kind === "wpisowe" ? "e" : "a"} — opłacone do ${formatDatePl(o.writeBack?.to || "")}`;
      lines = [
        "Skarbnik potwierdził Twoją wpłatę.",
        "",
        `Za: ${label}`,
        `Kwota: ${formatPln(o.amountPln)}`,
        `Składki opłacone do: ${formatDatePl(o.writeBack?.to || "")}`,
        "",
        "Dziękujemy!",
      ];
    }
    const body = [...lines, "", vars.appUrl, "", "SKK Morzkulc"].join("\n");
    await ctx.workspace.sendGenericEmail(o.userEmail, subject, body);
    await ref.update({[mark]: new Date()});
    return {ok: true, message: `Mail (${payload.kind}) wysłany.`};
  },
};

// ─── Przypomnienie o zaległości ─────────────────────────────────────────────

async function sendDuesReminderMail(ctx: ServiceTaskContext, u: any, intro: string): Promise<string> {
  const vars = await getAppVars(ctx.firestore);
  const st = computeDuesStatus(u, vars);
  const to = normNullish(u?.email).toLowerCase();
  if (!to.includes("@")) return "brak e-maila";
  const what = st.kind === "wpisowe" ? "wpisowego" : "składek członkowskich";
  const lines = [intro, ""];
  lines.push(`Opłacone do: ${st.paidUntil ? formatDatePl(st.paidUntil) : "brak wpłat"}`);
  if (st.overdue) lines.push(`Zaległość: ${st.overdue} ${st.overdue === 1 ? "semestr" : st.overdue < 5 ? "semestry" : "semestrów"}`);
  lines.push("");
  if (st.blocked) {
    lines.push(`Zaległość przekracza ${st.maxOverdue} semestrów — skontaktuj się z Zarządem (zarzad@morzkulc.pl), który zdecyduje o dalszym postępowaniu.`);
  } else {
    lines.push(st.kind === "wpisowe" ?
      `Wpisowe: ${formatPln(2 * st.feePln)} (2 semestry).` :
      `Składka: ${formatPln(st.feePln)} za semestr${st.overdue ? ` — do wyrównania zaległości ${formatPln(st.overdue * st.feePln)}` : ""}.`);
    lines.push(accountLines(vars));
    lines.push(`Wpłatę zgłoś w aplikacji (Profil → Składki) — dostaniesz tytuł przelewu, a skarbnik potwierdzi zaksięgowanie ${what}.`);
  }
  lines.push("", vars.appUrl, "", "SKK Morzkulc");
  await ctx.workspace.sendGenericEmail(to, `Przypomnienie o ${st.kind === "wpisowe" ? "wpisowym" : "składkach"} — SKK Morzkulc`, lines.join("\n"));
  return "";
}

type ReminderPayload = {uid: string; requestedBy?: string};

export const duesSendReminderTask: ServiceTask<ReminderPayload> = {
  id: "dues.sendReminder",
  description: "Składki: przypomnienie o zaległości wysłane przez skarbnika.",

  validate: (payload) => {
    if (!payload?.uid) throw new Error("Missing uid");
  },

  run: async (payload, ctx) => {
    const ref = ctx.firestore.collection("users_active").doc(payload.uid);
    const u = (await ref.get()).data();
    if (!u) return {ok: true, message: "Konto nie istnieje — pominięte."};
    const skip = await sendDuesReminderMail(ctx, u, "Przypominamy o zaległych opłatach w SKK Morzkulc.");
    if (skip) return {ok: true, message: `Pominięte: ${skip}`};
    await ref.update({"service.duesReminderSentAt": new Date(), "service.duesReminderSentBy": normNullish(payload.requestedBy)});
    return {ok: true, message: "Przypomnienie wysłane."};
  },
};

// ─── dues.daily ─────────────────────────────────────────────────────────────

export const duesDailyTask: ServiceTask<Record<string, never>> = {
  id: "dues.daily",
  description: "Składki: alert do skarbnika o zgłoszeniach > N dni + przypomnienia dla chętnych przed końcem opłaconego okresu.",

  validate: () => undefined,

  run: async (_payload, ctx) => {
    const db = ctx.firestore;
    const vars = await getAppVars(db);
    const today = todayWarsawIso();

    // 1) Zgłoszenia czekające dłużej niż N dni → jeden mail do skarbnika (każde zgłoszenie raz).
    const cutoff = ctx.now.getTime() - vars.duesTreasurerAlertDays * 86400000;
    const pending = (await db.collection(DUES_ORDERS).where("status", "==", "pending").get()).docs
      .map((d) => d.data() as DuesOrder & {treasurerAlertedAt?: any})
      .filter((o) => !o.treasurerAlertedAt && o.createdAt?.toMillis && o.createdAt.toMillis() <= cutoff);
    let alerted = 0;
    if (pending.length) {
      const mailbox = await resolveFunctionRoleMailbox(db, "skarbnik");
      if (mailbox) {
        const body = [
          `Zgłoszenia wpłat czekające na potwierdzenie dłużej niż ${vars.duesTreasurerAlertDays} dni:`,
          "",
          ...pending.map((o) => `• ${o.userName} (ID ${o.memberId}) — ${orderLabel(o)}, ${formatPln(o.amountPln)}, tytuł: ${o.transferTitle}`),
          "",
          "Potwierdź albo odrzuć w aplikacji: Panel Zarządu → Składki.",
          "",
          vars.appUrl,
        ].join("\n");
        await ctx.workspace.sendGenericEmail(mailbox, `Składki: ${pending.length} zgłosz. czeka na potwierdzenie`, body);
        for (const o of pending) await db.collection(DUES_ORDERS).doc(o.id).update({treasurerAlertedAt: new Date()});
        alerted = pending.length;
      }
    }

    // 2) Przypomnienia dla chętnych: N dni przed końcem opłaconego okresu (albo po nim), raz na każdą datę.
    let reminded = 0;
    if (vars.semesterEnds.length && vars.duesFeePln > 0) {
      const limit = new Date(`${today}T00:00:00Z`);
      limit.setUTCDate(limit.getUTCDate() + vars.duesReminderDays);
      const limitIso = limit.toISOString().slice(0, 10);
      const users = await db.collection("users_active").where("role_key", "in", MEMBER_ROLE_KEYS).get();
      for (const d of users.docs) {
        const u = d.data() as any;
        if (u?.profile?.notifications?.duesReminder !== true) continue;
        if (u?.status_key !== "status_aktywny" || !isRegistered(u)) continue;
        if (await isTestAccount(db, normNullish(u?.email))) continue;
        const paidUntil = effectivePaidUntilIso(u?.admin?.contributions);
        if (paidUntil && paidUntil > limitIso) continue;
        const key = paidUntil || "brak";
        if (u?.service?.duesAutoReminderFor === key) continue;
        const st = computeDuesStatus(u, vars, today);
        if (st.blocked) continue;
        const intro = paidUntil && paidUntil >= today ?
          `Twój opłacony okres kończy się ${formatDatePl(paidUntil)}.` :
          "Masz nieopłacone składki.";
        const skip = await sendDuesReminderMail(ctx, u, `${intro} (Przypomnienie włączone w Profil → Powiadomienia e-mail.)`);
        if (skip) continue;
        await d.ref.update({"service.duesAutoReminderFor": key});
        reminded++;
        ctx.logger.info("dues.daily: przypomnienie", {uid: d.id, name: fullName(u), paidUntil});
      }
    }
    return {ok: true, message: `Alert skarbnika: ${alerted}; przypomnienia: ${reminded}`, details: {alerted, reminded}};
  },
};
