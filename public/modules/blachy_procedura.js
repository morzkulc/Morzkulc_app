// public/modules/blachy_procedura.js
// Procedura nadawania Blach (regulamin v3.0) w module Klub → Blachy:
// status i terminy, skład Kapituły, zgłaszanie kandydatów, panel Kapituły (weryfikacja,
// tajne głosowanie, uzasadnienia) i panel Zarządu (zatwierdzenie, przyjęcie, ogłoszenie).
// Dane: /api/blachy/* (funkcja blachyApi). Nic się nie pokazuje, gdy procedura wyłączona w SETUP.
import { apiGetJson, apiPostJson } from "/core/api_client.js";
import { mapUserFacingApiError } from "/core/user_error_messages.js";
import { escapeHtml, escapeAttr } from "/core/html_utils.js";

const API = "/api/blachy";
const MIES = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];
const d = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${Number(m[3])} ${MIES[Number(m[2]) - 1]}` : "";
};

const STATUS = {
  do_weryfikacji: "w weryfikacji",
  nieprawidlowa: "odrzucona (nieprawidłowa)",
  otwarte: "głosowanie otwarte",
  zakonczone: "głosowanie zakończone",
  odroczone: "odroczona (brak 5 bezstronnych osób)",
};
const PRZYJECIE = { oczekuje: "czeka na odpowiedź", przyjeta: "przyjęta", odmowa: "nie przyjęta", brak_maila: "brak e-maila — potwierdź ręcznie" };

function fazaText(s) {
  const t = s.terminy;
  switch (s.faza) {
  case "przed": return `Zgłaszanie kandydatów: ${d(t.nominacjeOd)} – ${d(t.nominacjeDo)}.`;
  case "nominacje": return `Trwa zgłaszanie kandydatów — do ${d(t.nominacjeDo)}.`;
  case "weryfikacja":
  case "glosowanie": return `Nominacje zamknięte. Kapituła rozpatruje kandydatury (głosowanie do ${d(t.glosowanieDo)}).`;
  case "zatwierdzenie": return `Kapituła kończy pracę. Zarząd zatwierdza wyniki do ${d(t.zatwierdzenieDo)}.`;
  default: return s.ogloszono ? "Wyniki tegorocznej procedury zostały ogłoszone." : "Procedura w toku — wyniki po zatwierdzeniu przez Zarząd.";
  }
}

function nominacjaForm(s, n) {
  const k = n?.kandydat || {};
  const spoza = n ? !k.uid : false;
  const opts = (s.osoby || []).map((o) => `<option value="${escapeAttr(o.uid)}" ${o.hasBlacha ? "disabled" : ""} ${k.uid === o.uid ? "selected" : ""}>${
    escapeHtml(o.label)}${o.hasBlacha ? " — ma już Blachę" : ""}</option>`).join("");
  const val = (x) => escapeAttr(x || "");
  return `<form class="blachyForm" data-bp-form="${escapeAttr(n ? n.id : "new")}" novalidate>
    <label class="blachyCheck"><input type="checkbox" name="spoza" ${spoza ? "checked" : ""}> Kandydat spoza listy (np. były członek bez konta, członek innego klubu)</label>
    <label class="blachyField" data-bp-lista ${spoza ? "hidden" : ""}><span>Kandydat</span><select name="uid"><option value="">— wybierz —</option>${opts}</select></label>
    <div class="blachyGrid" data-bp-spoza ${spoza ? "" : "hidden"}>
      <label class="blachyField"><span>Imię</span><input name="imie" value="${val(spoza ? k.imie : "")}"></label>
      <label class="blachyField"><span>Nazwisko</span><input name="nazwisko" value="${val(spoza ? k.nazwisko : "")}"></label>
      <label class="blachyField"><span>Ksywa</span><input name="ksywa" value="${val(spoza ? k.ksywa : "")}"></label>
      <label class="blachyField"><span>Klub (jeśli inny)</span><input name="klub" value="${val(spoza ? k.klub : "")}"></label>
      <label class="blachyField"><span>E-mail kandydata (do potwierdzenia przyjęcia)</span><input name="email" type="email" value="${val(spoza ? k.email : "")}"></label>
    </div>
    <fieldset class="blachyObszary"><legend>Obszary zasług (§2)</legend>${(s.obszary || []).map((o) =>
    `<label class="blachyCheck"><input type="checkbox" name="obszary" value="${escapeAttr(o)}" ${(n?.obszary || []).includes(o) ? "checked" : ""}> ${escapeHtml(o)}</label>`).join("")}</fieldset>
    <label class="blachyField"><span>Konkretne zasługi kandydata</span><textarea name="zaslugi" rows="4">${escapeHtml(n?.zaslugi || "")}</textarea></label>
    <label class="blachyField"><span>Uzasadnienie nominacji</span><textarea name="uzasadnienie" rows="3">${escapeHtml(n?.uzasadnienie || "")}</textarea></label>
    <p class="err" data-bp-err hidden></p>
    <div class="blachyActions"><button type="submit" class="primary">${n ? "Zapisz zmiany" : "Wyślij zgłoszenie"}</button><button type="button" class="ghost" data-bp="cancel">Anuluj</button></div>
  </form>`;
}

function renderStan(s, ui) {
  const kap = s.kapitula.some((x) => x.czlonek) ? `<details class="blachyUzas"><summary>Skład Kapituły Blach</summary><ol class="klubList">${
    s.kapitula.map((x) => `<li>${escapeHtml(x.czlonek || "—")}${x.zastepca ? ` <span class="hint">(zastępca: ${escapeHtml(x.zastepca)})</span>` : ""}</li>`).join("")
  }</ol>${s.przewodniczacy ? `<p class="hint">Przewodniczący: ${escapeHtml(s.przewodniczacy)}</p>` : ""}</details>` : "";
  let nom = "";
  if (s.canNominate) {
    nom = ui.form ? nominacjaForm(s, ui.form === "new" ? null : s.moje.find((m) => m.id === ui.form))
      : `<div class="blachyActions"><button type="button" class="primary" data-bp="new">Zgłoś kandydata</button></div>`;
    if (s.moje.length) {
      nom += `<p class="hint">Twoje zgłoszenia (widzisz je tylko Ty i Kapituła):</p><ul class="klubList">${s.moje.map((m) =>
        `<li>${escapeHtml(m.label)} <button type="button" class="ghost" data-bp="edit" data-id="${escapeAttr(m.id)}">Popraw</button> <button type="button" class="dangerBtn" data-bp="withdraw" data-id="${escapeAttr(m.id)}">Wycofaj</button></li>`).join("")}</ul>`;
    }
  }
  const btns = [
    s.isKapitula && !["przed", "nominacje"].includes(s.faza) ? `<button type="button" class="ghost" data-bp="kapitula">${ui.panel === "kapitula" ? "Zamknij panel Kapituły" : "Panel Kapituły"}</button>` : "",
    s.isZarzad && !["przed", "nominacje"].includes(s.faza) ? `<button type="button" class="ghost" data-bp="zarzad">${ui.panel === "zarzad" ? "Zamknij panel Zarządu" : "Panel Zarządu"}</button>` : "",
  ].filter(Boolean).join("");
  return `<div class="profileBlock blachyProc">
    <h3 class="profileBlockTitle">Blachy ${escapeHtml(String(s.rok))}</h3>
    <p>${escapeHtml(fazaText(s))}</p>${kap}${nom}
    ${btns ? `<div class="blachyActions">${btns}</div>` : ""}
    <div data-bp-panel></div>
  </div>`;
}

function renderKapitula(k) {
  const pr = k.isPrzewodniczacy;
  const wer = k.kandydatury.filter((x) => x.status === "do_weryfikacji");
  const zwrot = k.zwrot ? `<p class="err">Zarząd zwrócił sprawę: ${escapeHtml(k.zwrot)}</p>` : "";
  if (!k.kandydatury.length) return `${zwrot}<p class="hint">Brak kandydatur.</p>`;
  return `${zwrot}<p class="hint">Blacha: co najmniej ${k.prog} głosy TAK z ${k.seats}. Głosowanie tajne — zapisywane są tylko sumy, wyniki widać po oddaniu wszystkich głosów.</p>${
    k.kandydatury.map((c) => {
      const noms = c.nominacje.map((n) => `<div class="blachyNom"><div class="hint">Zgłasza: ${escapeHtml(n.autor)}${n.obszary.length ? ` · ${escapeHtml(n.obszary.join(", "))}` : ""}</div>
        <p><strong>Zasługi:</strong> ${escapeHtml(n.zaslugi)}</p><p><strong>Uzasadnienie:</strong> ${escapeHtml(n.uzasadnienie)}</p></div>`).join("");
      const a = [];
      const id = escapeAttr(c.id);
      if (c.status === "do_weryfikacji" && !k.zatwierdzono) {
        a.push(c.wylaczonyJa ? `<button type="button" class="ghost" data-bk="unconflict" data-id="${id}">Cofnij wyłączenie</button>`
          : `<button type="button" class="ghost" data-bk="conflict" data-id="${id}">Wyłączam się (konflikt interesów)</button>`);
        if (pr) {
          a.push(`<button type="button" class="primary" data-bk="open" data-id="${id}">Otwórz głosowanie</button>`);
          a.push(`<button type="button" class="dangerBtn" data-bk="invalidate" data-id="${id}">Odrzuć jako nieprawidłową</button>`);
          const others = wer.filter((x) => x.id !== c.id);
          if (others.length) {
            a.push(`<select data-bk-into="${id}"><option value="">Połącz z…</option>${others.map((o) => `<option value="${escapeAttr(o.id)}">${escapeHtml(o.label)}</option>`).join("")}</select><button type="button" class="ghost" data-bk="merge" data-id="${id}">Połącz</button>`);
          }
        }
      }
      if (c.status === "nieprawidlowa" && pr && !k.zatwierdzono) a.push(`<button type="button" class="ghost" data-bk="restore" data-id="${id}">Przywróć</button>`);
      if (c.status === "otwarte") {
        a.push(`<span class="hint">Oddane głosy: ${c.oddane}/${k.seats}</span>`);
        if (c.glosujeJa && !c.oddalemJa) {
          a.push(`<button type="button" class="primary" data-bk="vote" data-glos="tak" data-id="${id}">TAK</button><button type="button" class="ghost" data-bk="vote" data-glos="nie" data-id="${id}">NIE</button>`);
        } else a.push(`<span class="hint">${c.oddalemJa ? "Twój głos jest oddany." : "Nie głosujesz w tej sprawie."}</span>`);
      }
      let wynik = "";
      if (c.status === "zakonczone") {
        wynik = `<p><strong>${c.decyzja === "wybrany" ? "Wybrany" : "Niewybrany"}</strong> — TAK ${c.wynik?.tak ?? "?"}, NIE ${c.wynik?.nie ?? "?"}</p>`;
        if (c.decyzja === "wybrany") {
          wynik += pr && !k.zatwierdzono ? `<label class="blachyField"><span>Uzasadnienie Kapituły (do ogłoszenia i Rejestru)</span><textarea data-bk-uz="${id}" rows="3">${escapeHtml(c.uzasadnienieKapituly)}</textarea></label>
            <div class="blachyActions"><button type="button" class="primary" data-bk="uzasadnienie" data-id="${id}">Zapisz uzasadnienie</button></div>`
            : (c.uzasadnienieKapituly ? `<p><strong>Uzasadnienie:</strong> ${escapeHtml(c.uzasadnienieKapituly)}</p>` : `<p class="hint">Brak uzasadnienia — dodaje przewodniczący.</p>`);
        }
      }
      if (k.zwrot && pr && ["zakonczone", "odroczone"].includes(c.status)) a.push(`<button type="button" class="ghost" data-bk="reset" data-id="${id}">Rozpatrz ponownie</button>`);
      return `<div class="blachyKand">
        <div class="blachyOsoba">${escapeHtml(c.label)} <span class="hint">· ${escapeHtml(STATUS[c.status] || c.status)}${c.spozaKlubu ? " · spoza listy członków" : ""}</span></div>
        <details class="blachyUzas"><summary>Zgłoszenia (${c.nominacje.length})</summary>${noms}</details>
        ${wynik}${a.length ? `<div class="blachyActions">${a.join("")}</div>` : ""}
      </div>`;
    }).join("")}<p class="err" data-bp-err hidden></p>`;
}

function renderZarzad(z) {
  const l = z.liczby;
  const ready = l.kandydatury > 0 && l.wGlosowaniu === 0;
  const wybrani = z.wybrani.length ? `<ul class="klubList">${z.wybrani.map((w) => `<li>${escapeHtml(w.label)}
    <div class="hint">${w.uzasadnienie ? escapeHtml(w.uzasadnienie) : "brak uzasadnienia Kapituły"}</div>
    ${z.zatwierdzenie ? `<div class="hint">Przyjęcie: ${escapeHtml(PRZYJECIE[w.przyjecie] || "—")}</div>${
      ["oczekuje", "brak_maila"].includes(w.przyjecie) ? `<div class="blachyActions"><button type="button" class="ghost" data-bz="accept_manual" data-status="przyjeta" data-id="${escapeAttr(w.id)}">Przyjęta (potwierdzone osobiście)</button><button type="button" class="ghost" data-bz="accept_manual" data-status="odmowa" data-id="${escapeAttr(w.id)}">Nie przyjęta</button></div>` : ""}` : ""}
  </li>`).join("")}</ul>` : `<p class="hint">Kapituła nie wybrała nikogo.</p>`;
  let akcje = "";
  if (z.ogloszono) akcje = `<p>Wyniki ogłoszone.</p>`;
  else if (z.zatwierdzenie) {
    akcje = `<p>Zatwierdzone uchwałą: ${escapeHtml(z.zatwierdzenie.uchwala)}. Wyróżnieni dostali prośbę o potwierdzenie przyjęcia.</p>
      <div class="blachyActions"><button type="button" class="primary" data-bz="announce">Ogłoś wyniki (lista, Rejestr, zgłaszający)</button></div>`;
  } else if (ready) {
    akcje = `<label class="blachyField"><span>Uchwała Zarządu (numer / data)</span><input data-bz-uchwala></label>
      <div class="blachyActions"><button type="button" class="primary" data-bz="approve">Zatwierdź</button></div>
      <label class="blachyField"><span>Zwrot do Kapituły — wskaż naruszenie regulaminu</span><textarea data-bz-powod rows="2"></textarea></label>
      <div class="blachyActions"><button type="button" class="dangerBtn" data-bz="return">Zwróć Kapitule</button></div>`;
  } else akcje = `<p class="hint">Kapituła nie zakończyła jeszcze głosowań (${l.wGlosowaniu} w toku).</p>`;
  return `<p>Rozpatrywane kandydatury: <strong>${l.kandydatury}</strong> · odroczone: ${l.odroczone} · wybrani: <strong>${l.wybrani}</strong></p>
    ${z.zwrot ? `<p class="err">Zwrócono Kapitule: ${escapeHtml(z.zwrot)}</p>` : ""}${wybrani}${akcje}<p class="err" data-bp-err hidden></p>`;
}

/** Montuje procedurę w kontenerze; onRegistryChange — odświeżenie Rejestru po ogłoszeniu. */
export async function mountBlachyProcedura(el, ctx) {
  const ui = { form: null, panel: null };
  let s = null;
  const showErr = (e, scope) => {
    const box = (scope || el).querySelector("[data-bp-err]") || el.querySelector("[data-bp-err]");
    const msg = e?.fields ? Object.values(e.fields).join(" · ") : mapUserFacingApiError(e, "Nie udało się.");
    if (box) {
      box.textContent = msg;
      box.hidden = false;
    } else window.alert(msg);
  };
  const loadPanel = async () => {
    const p = el.querySelector("[data-bp-panel]");
    if (!p || !ui.panel) return;
    p.innerHTML = `<p class="hint">Ładuję…</p>`;
    try {
      const data = await apiGetJson({ url: `${API}/${ui.panel}`, idToken: ctx.idToken });
      p.innerHTML = ui.panel === "kapitula" ? renderKapitula(data) : renderZarzad(data);
    } catch (e) {
      p.innerHTML = `<p class="err">${escapeHtml(mapUserFacingApiError(e, "Nie udało się pobrać danych."))}</p>`;
    }
  };
  const render = async (reload = true) => {
    if (reload) {
      try {
        s = await apiGetJson({ url: `${API}/stan`, idToken: ctx.idToken });
      } catch {
        el.innerHTML = "";
        return;
      }
    }
    if (!s?.wlaczona) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = renderStan(s, ui);
    await loadPanel();
  };
  const post = async (path, body, scope) => {
    try {
      await apiPostJson({ url: `${API}/${path}`, idToken: ctx.idToken, body });
      return true;
    } catch (e) {
      showErr(e, scope);
      return false;
    }
  };

  el.addEventListener("change", (ev) => {
    if (ev.target.name === "spoza") {
      const f = ev.target.closest("form");
      f.querySelector("[data-bp-lista]").hidden = ev.target.checked;
      f.querySelector("[data-bp-spoza]").hidden = !ev.target.checked;
    }
  });
  el.addEventListener("submit", async (ev) => {
    const f = ev.target.closest("[data-bp-form]");
    if (!f) return;
    ev.preventDefault();
    const fd = new FormData(f);
    const spoza = f.querySelector("[name=spoza]").checked;
    const kandydat = spoza
      ? { imie: fd.get("imie"), nazwisko: fd.get("nazwisko"), ksywa: fd.get("ksywa"), klub: fd.get("klub"), email: fd.get("email") }
      : { uid: fd.get("uid") };
    const id = f.getAttribute("data-bp-form");
    const data = { kandydat, obszary: fd.getAll("obszary"), zaslugi: fd.get("zaslugi"), uzasadnienie: fd.get("uzasadnienie") };
    if (await post("nominacja", id === "new" ? { action: "add", data } : { action: "update", id, data }, f)) {
      ui.form = null;
      await render();
    }
  });
  el.addEventListener("click", async (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    const id = b.getAttribute("data-id");
    const bp = b.getAttribute("data-bp");
    if (bp === "new" || bp === "edit") {
      ui.form = bp === "new" ? "new" : id;
      return void render(false);
    }
    if (bp === "cancel") {
      ui.form = null;
      return void render(false);
    }
    if (bp === "withdraw") {
      if (!window.confirm("Wycofać to zgłoszenie?")) return;
      if (await post("nominacja", { action: "withdraw", id })) await render();
      return;
    }
    if (bp === "kapitula" || bp === "zarzad") {
      ui.panel = ui.panel === bp ? null : bp;
      return void render(false);
    }
    const bk = b.getAttribute("data-bk");
    if (bk) {
      const body = { action: bk, id };
      if (bk === "vote") {
        body.glos = b.getAttribute("data-glos");
        if (!window.confirm(`Oddać głos ${body.glos.toUpperCase()}? Głosu nie można zmienić.`)) return;
      }
      if (bk === "merge") {
        body.into = el.querySelector(`[data-bk-into="${CSS.escape(id)}"]`)?.value;
        if (!body.into) return;
      }
      if (bk === "uzasadnienie") body.text = el.querySelector(`[data-bk-uz="${CSS.escape(id)}"]`)?.value || "";
      if ((bk === "invalidate" || bk === "open" || bk === "reset") && !window.confirm("Na pewno?")) return;
      if (await post("kapitula", body)) await loadPanel();
      return;
    }
    const bz = b.getAttribute("data-bz");
    if (bz) {
      const body = { action: bz, id, status: b.getAttribute("data-status") };
      if (bz === "approve") body.uchwala = el.querySelector("[data-bz-uchwala]")?.value || "";
      if (bz === "return") body.powod = el.querySelector("[data-bz-powod]")?.value || "";
      if ((bz === "approve" || bz === "return" || bz === "announce") && !window.confirm("Na pewno?")) return;
      if (await post("zarzad", body)) await loadPanel();
    }
  });

  await render();
}
