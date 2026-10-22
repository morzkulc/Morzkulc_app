// Zapis na kurs: logowanie Google (Firebase Auth projektu prod) → formularz →
// POST https://app.morzkulc.pl/api/kurs/zgloszenie → dane do przelewu.
// Edycja, kwoty, konto i odpowiedzi wyboru przychodzą z API (arkusz SETUP) — nic na sztywno.
import {initializeApp} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const API = "https://app.morzkulc.pl/api/kurs/zgloszenie";

// Ten sam projekt co aplikacja (public/core/firebase_client.js, PROD_BASE). authDomain = bieżący
// host: Hosting serwuje /__/auth/handler pod każdą podłączoną domeną, a przeskok na inną
// domenę w trakcie logowania psuje powrót na iOS Safari.
const app = initializeApp({
  apiKey: "AIzaSyDp8Gyd45RkSS6cdJ32oczHGe6Fb9RrWeo",
  projectId: "morzkulc-e9df7",
  storageBucket: "morzkulc-e9df7.firebasestorage.app",
  messagingSenderId: "137214816080",
  appId: "1:137214816080:web:e4a1a6a1e25a0c694ac655",
  authDomain: location.hostname,
});
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({prompt: "select_account"});

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const MONTHS = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"];
const pln = (n) => (n == null ? "" : Number(n).toLocaleString("pl-PL") + " zł");
const datePL = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
};

let user = null;
let data = null; // ostatnia odpowiedź GET/POST

function show(state) {
  $$(".z-state").forEach((el) => {
    el.hidden = el.dataset.state !== state;
  });
}

function fail(msg) {
  $(".js-error").textContent = msg;
  show("error");
}

async function api(method, body) {
  const token = await user.getIdToken();
  const r = await fetch(API, {
    method,
    headers: {"Authorization": "Bearer " + token, ...(body ? {"Content-Type": "application/json"} : {})},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch (e) {
    json = null;
  }
  return {status: r.status, json: json || {}};
}

// ---------- formularz ----------
function buildOptions(opcje) {
  $$(".z-opts").forEach((box) => {
    if (box.childElementCount) return;
    const name = box.dataset.name;
    const type = box.dataset.type;
    let values;
    let labels;
    if (type === "yesno") {
      values = ["true", "false"];
      labels = ["Tak", "Nie"];
    } else if (box.dataset.values) {
      values = box.dataset.values.split("|");
      labels = box.dataset.labels.split("|");
    } else {
      values = opcje[name] || [];
      labels = values;
    }
    values.forEach((v, i) => {
      const l = document.createElement("label");
      l.className = "z-opt";
      const inp = document.createElement("input");
      inp.type = type === "checkbox" ? "checkbox" : "radio";
      inp.name = name;
      inp.value = v;
      l.appendChild(inp);
      l.appendChild(document.createTextNode(" " + labels[i]));
      box.appendChild(l);
    });
  });
}

function radioVal(form, name) {
  const el = form.querySelector(`input[name="${name}"]:checked`);
  return el ? el.value : "";
}

function applyConditions(form) {
  $$("[data-if]", form).forEach((el) => {
    const neg = el.dataset.if.includes("!=");
    const [name, val] = el.dataset.if.split(neg ? "!=" : "=");
    el.hidden = neg ? radioVal(form, name) === val : radioVal(form, name) !== val;
  });
}

function collect(form) {
  const v = (n) => (form.elements[n] ? String(form.elements[n].value || "").trim() : "");
  const yes = (n) => {
    const r = radioVal(form, n);
    return r === "" ? null : r === "true";
  };
  const checks = (n) => $$(`input[name="${n}"]:checked`, form).map((x) => x.value);
  return {
    imie: v("imie"), nazwisko: v("nazwisko"), telefon: v("telefon"), dataUrodzenia: v("dataUrodzenia"),
    miejscowosc: v("miejscowosc"), pesel: v("pesel").replace(/\s/g, ""), brakPesel: form.elements.brakPesel.checked, dokument: v("dokument"), iceImie: v("iceImie"), iceTelefon: v("iceTelefon"),
    doswiadczenie: radioVal(form, "doswiadczenie"), plywanie: radioVal(form, "plywanie"), sporty: v("sporty"),
    chorobyPrzewlekle: yes("chorobyPrzewlekle"), chorobyOpis: v("chorobyOpis"),
    leki: yes("leki"), lekiOpis: v("lekiOpis"), schorzenia: checks("schorzenia"),
    wzrost: v("wzrost"), waga: v("waga"),
    student: yes("student"), uczelnia: v("uczelnia"), dieta: radioVal(form, "dieta"), wegeMieso: radioVal(form, "wegeMieso"),
    dlaczego: v("dlaczego"), zainteresowania: checks("zainteresowania"), rokPoKursie: v("rokPoKursie"),
    pasje: v("pasje"), dlaczegoTy: v("dlaczegoTy"), skad: radioVal(form, "skad"),
    zgodaRegulamin: form.elements.zgodaRegulamin.checked,
    zgodaZdrowie: form.elements.zgodaZdrowie.checked,
    zgodaRodo: form.elements.zgodaRodo.checked,
    zgodaStatut: form.elements.zgodaStatut.checked,
    zgodaWizerunek: form.elements.zgodaWizerunek.checked,
  };
}

function clearErrors(form) {
  $$(".z-errmsg", form).forEach((e) => e.remove());
  $$(".has-err", form).forEach((e) => e.classList.remove("has-err"));
  $(".js-formerr").hidden = true;
}

function showErrors(form, fields) {
  let first = null;
  Object.entries(fields).forEach(([name, msg]) => {
    const input = form.elements[name];
    const host = (input && input.closest && input.closest(".z-f")) ||
      (input && input[0] && input[0].closest(".z-f")) ||
      form.querySelector(`.z-opts[data-name="${name}"]`)?.closest(".z-f") ||
      form.querySelector(`[data-err="${name}"]`);
    if (!host) return;
    host.classList.add("has-err");
    const m = document.createElement("span");
    m.className = "z-errmsg";
    m.textContent = msg;
    host.appendChild(m);
    if (!first) first = host;
  });
  const fe = $(".js-formerr");
  fe.textContent = "Popraw zaznaczone pola.";
  fe.hidden = false;
  if (first) first.scrollIntoView({behavior: "smooth", block: "center"});
}

function prefill(form) {
  const name = (user.displayName || "").trim().split(/\s+/);
  if (name.length >= 2 && !form.elements.imie.value) {
    form.elements.imie.value = name[0];
    form.elements.nazwisko.value = name.slice(1).join(" ");
  }
}

// ---------- ekran po zgłoszeniu ----------
const STATUS = {
  nowe: ["Zgłoszenie przyjęte", "Miejsce rezerwuje wpłata zadatku. Po jego zaksięgowaniu dostaniesz maila z dostępem do aplikacji klubowej."],
  zadatek: ["Zadatek zaksięgowany — jesteś na kursie", "Masz dostęp do aplikacji klubowej (app.morzkulc.pl): zaloguj się tym samym kontem Google i zaznacz, że jesteś kursantem."],
  oplacony: ["Kurs opłacony — jesteś na kursie", "Do zobaczenia na wodzie! Zapisy na baseny znajdziesz w aplikacji klubowej (app.morzkulc.pl)."],
  rezygnacja: ["Zgłoszenie wycofane", "Twoje zgłoszenie zostało wycofane. W razie pytań napisz do nas."],
};

function renderDone(z) {
  const [title, sub] = STATUS[z.status] || STATUS.nowe;
  $(".js-status").textContent = title;
  $(".js-status-sub").textContent = sub;
  const p = z.przelew || {};
  const pay = $(".js-pay");
  pay.hidden = z.status === "oplacony" || z.status === "rezygnacja";
  $(".js-zadatek").textContent = z.status === "zadatek" ? "wpłacony" : pln(p.zadatek);
  $(".js-konto").textContent = p.konto || "—";
  $(".js-bank").textContent = p.bank || "";
  $(".js-tytul").textContent = p.tytul || "";
  $$(".js-cena-row").forEach((el) => {
    el.hidden = !p.cena;
  });
  $(".js-cena").textContent = pln(p.cena) + (p.ulga ? ` (${p.ulga})` : "");
  $(".js-doplata").textContent = p.terminDoplaty ? ` — pozostałą kwotę wpłać do ${datePL(p.terminDoplaty)}` : "";
  $$(".z-copy").forEach((b) => {
    b.onclick = () => {
      const t = b.dataset.copy === "konto" ? (p.konto || "").replace(/\s/g, "") : p.tytul;
      navigator.clipboard?.writeText(t).then(() => {
        b.textContent = "skopiowano";
        setTimeout(() => {
          b.textContent = "kopiuj";
        }, 1500);
      });
    };
  });
  show("done");
}

// ---------- przebieg ----------
function render() {
  const k = data.kurs || {};
  $$(".js-edycja").forEach((el) => {
    el.textContent = k.edycja || "";
  });
  $$(".js-email").forEach((el) => {
    el.textContent = data.email || "";
  });
  const demo = $(".js-demo");
  demo.hidden = !k.demo;
  if (k.demo) {
    demo.textContent = `Tryb testowy do ${datePL(k.demoDo)}: zgłoszenia są próbne i po tym dniu zostaną usunięte. ` +
      "Testuj kontem Google, którego NIE ma w aplikacji klubowej. Nie wpłacaj pieniędzy.";
  }
  if (data.zgloszenie) return renderDone(data.zgloszenie);
  $(".js-logout2").hidden = !data.blokada;
  if (data.blokada) {
    $(".js-closed").textContent = data.blokada;
    return show("closed");
  }
  if (!k.zapisyOtwarte) {
    $(".js-closed").textContent = k.zapisyStatus === "wkrotce" ?
      "Zapisy jeszcze się nie rozpoczęły. Śledź stronę kursu i nasze profile." :
      "Zapisy na kurs są obecnie zamknięte.";
    return show("closed");
  }
  const form = $(".z-form");
  buildOptions(data.opcje || {});
  prefill(form);
  applyConditions(form);
  show("form");
}

async function load() {
  show("loading");
  const {status, json} = await api("GET");
  if (status !== 200) return fail(json.message || "Nie udało się wczytać danych. Spróbuj ponownie później.");
  data = json;
  render();
}

// Pełnoletność — od razu po wpisaniu daty (serwer sprawdza to samo przy wysłaniu).
function checkAge(form) {
  const input = form.elements.dataUrodzenia;
  const host = input.closest(".z-f");
  host.querySelector(".z-age")?.remove();
  host.classList.remove("has-err");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.value || "");
  if (!m) return;
  const t = new Date();
  const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  if (`${Number(m[1]) + 18}-${m[2]}-${m[3]}` <= today) return;
  host.classList.add("has-err");
  const msg = document.createElement("span");
  msg.className = "z-errmsg z-age";
  msg.textContent = "Kurs jest tylko dla osób pełnoletnich";
  host.appendChild(msg);
}

const form = $(".z-form");
form.addEventListener("change", (e) => {
  applyConditions(form);
  if (e.target.name === "dataUrodzenia") checkAge(form);
});
form.elements.dataUrodzenia.addEventListener("input", () => checkAge(form));
form.elements.dataUrodzenia.addEventListener("blur", () => checkAge(form));
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrors(form);
  const btn = $(".js-submit");
  btn.disabled = true;
  btn.textContent = "Wysyłanie…";
  try {
    const {status, json} = await api("POST", collect(form));
    if (status === 400 && json.fields) return showErrors(form, json.fields);
    if (status === 200 || json.code === "already_submitted") {
      data = {...data, ...json, zgloszenie: json.zgloszenie || data.zgloszenie};
      if (data.zgloszenie) {
        renderDone(data.zgloszenie);
        window.scrollTo({top: 0});
        return;
      }
      return load();
    }
    if (json.code === "account_blocked") {
      data = {...data, blokada: json.message};
      return render();
    }
    const fe = $(".js-formerr");
    fe.textContent = json.message || "Nie udało się wysłać zgłoszenia. Spróbuj ponownie.";
    fe.hidden = false;
  } catch (err) {
    const fe = $(".js-formerr");
    fe.textContent = "Brak połączenia. Sprawdź internet i spróbuj ponownie.";
    fe.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Zarezerwuj miejsce i przejdź do płatności zadatku";
  }
});

$(".js-login").addEventListener("click", async () => {
  try {
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) await signInWithRedirect(auth, provider);
    else await signInWithPopup(auth, provider);
  } catch (err) {
    if (err?.code !== "auth/popup-closed-by-user") fail("Logowanie nie powiodło się: " + (err?.code || err?.message || err));
  }
});
$(".js-logout").addEventListener("click", () => signOut(auth));
$(".js-logout2").addEventListener("click", () => signOut(auth));

getRedirectResult(auth).catch((err) => fail("Logowanie nie powiodło się: " + (err?.code || err?.message || err)))
  .finally(() => {
    onAuthStateChanged(auth, (u) => {
      user = u;
      if (!u) return show("login");
      load().catch(() => fail("Brak połączenia z serwerem. Spróbuj ponownie później."));
    });
  });
