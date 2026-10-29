import {ServiceTask} from "../types";
import {norm} from "../../modules/shared/text_utils";
import {getAppVars} from "../../modules/setup/app_vars";
import {BasenOrder, ORDERS} from "../../modules/basen/basen_orders";

type Payload = {
  orderId: string;
  kind: "created" | "rejected";
};

function pln(n: number): string {
  return `${Number(n || 0).toFixed(2).replace(".", ",").replace(",00", "")} zł`;
}

/**
 * Mail do zamawiającego godziny basenowe (basen_orders.ts):
 *  - created: potwierdzenie zamówienia + konto klubowe, kwota i tytuł przelewu,
 *  - rejected: odrzucenie przez opiekuna basenu z powodem.
 * Zatwierdzenie maila nie wysyła (decyzja 29.10.2026) — godziny basenowe widać na saldzie.
 */
export const basenNotifyOrderTask: ServiceTask<Payload> = {
  id: "basen.notifyOrder",
  description: "Basen: mail o zamówieniu godzin basenowych (złożone / odrzucone).",

  validate: (payload) => {
    if (!payload?.orderId) throw new Error("Missing orderId");
    if (payload.kind !== "created" && payload.kind !== "rejected") throw new Error("Invalid kind");
  },

  run: async (payload, ctx) => {
    const ref = ctx.firestore.collection(ORDERS).doc(payload.orderId);
    const snap = await ref.get();
    const o = snap.data() as (BasenOrder & {notifiedCreatedAt?: unknown; notifiedRejectedAt?: unknown}) | undefined;
    if (!snap.exists || !o) return {ok: true, message: "Zamówienie nie istnieje — mail pominięty."};

    const markField = payload.kind === "created" ? "notifiedCreatedAt" : "notifiedRejectedAt";
    if (o[markField]) return {ok: true, message: "Mail już wysłany."};

    const to = norm(o.userEmail);
    if (!to.includes("@")) return {ok: false, message: "Brak adresu e-mail."};

    const vars = await getAppVars(ctx.firestore);
    let subject: string;
    let body: string;
    if (payload.kind === "created") {
      subject = `Basen — zamówienie: ${o.label}`;
      body = [
        "Dziękujemy za zamówienie godzin basenowych.",
        "",
        `Zamówienie: ${o.label}`,
        `Kwota: ${pln(o.amountPln)}`,
        "",
        "Wpłać kwotę przelewem na konto klubu albo gotówką opiekunowi basenu:",
        vars.clubAccount ? `Konto: ${vars.clubAccount}${vars.clubBank ? ` (${vars.clubBank})` : ""}` : "Konto: podane w aplikacji (moduł Basen → Moje konto)",
        `Tytuł przelewu: ${o.transferTitle}`,
        "",
        "Godziny basenowe pojawią się na Twoim saldzie, gdy opiekun basenu potwierdzi wpłatę.",
        "Niezatwierdzone zamówienie możesz anulować w aplikacji.",
        "",
        vars.appUrl,
        "",
        "SKK Morzkulc",
      ].join("\n");
    } else {
      subject = `Basen — zamówienie odrzucone: ${o.label}`;
      body = [
        "Opiekun basenu odrzucił Twoje zamówienie godzin basenowych.",
        "",
        `Zamówienie: ${o.label}`,
        `Kwota: ${pln(o.amountPln)}`,
        `Powód: ${norm(o.rejectReason) || "—"}`,
        "",
        "Jeśli to pomyłka, odpowiedz na tego maila albo skontaktuj się z opiekunem basenu.",
        "",
        "SKK Morzkulc",
      ].join("\n");
    }

    await ctx.workspace.sendGenericEmail(to, subject, body);
    await ref.update({[markField]: new Date()});
    return {ok: true, message: `sent ${payload.kind} to ${to}`};
  },
};
