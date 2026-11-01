"""Otwarcia aplikacji przed i po konsolidacji (appApi). Czyta req.json (reqlogs.js, z polem u = ścieżka)
oraz opcjonalnie rev.json (rewizje appapi) z bieżącego katalogu.

Otwarcie = żądanie /api/register (po) albo funkcja registeruser (przed) + żądania ekranu startowego
w oknie -3 s … +20 s. Fala 1: register + setup, fala 2: ekran główny. Czekanie na serwer = max(fala 1) + max(fala 2).
Zimne żądanie = pierwsze żądanie nowej instancji. Zimne starty po wdrożeniu (pierwsza instancja nowej rewizji)
liczone osobno, bo nie wynikają z bezczynności.
"""
import collections
import datetime as D
import json
import os

req = json.load(open("req.json"))
rev = json.load(open("rev.json")) if os.path.exists("rev.json") else []


def ts(s):
    return D.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


for r in req:
    r["T"] = ts(r["t"])
req = [r for r in req if r["m"] in ("GET", "POST") and r["lat"] is not None]
req.sort(key=lambda r: r["T"])

seen = set()
for r in req:
    r["cold"] = bool(r["inst"]) and r["inst"] not in seen
    if r["inst"]:
        seen.add(r["inst"])
# instancje startujące tuż po wdrożeniu nowej rewizji appapi
first_by_rev = {}
for x in sorted(rev, key=lambda x: x["t"]):
    first_by_rev.setdefault(x["rev"], x["inst"])
deploy_inst = set(first_by_rev.values())

T0 = req[0]["T"] + 7200  # pierwsze 2 h: instancje sprzed okna fałszywie „zimne”
SWITCH = min((r["T"] for r in req if r["fn"] == "appapi"), default=None)

OLD_W1 = {"registeruser", "getsetup"}
OLD_W2 = {"geteventinterests", "getevents", "getgodzinki", "kmmystats", "getadminpending", "getklubinfo", "notificationprefs",
          "getbasensessions", "basenapi", "getkursinfo", "getkursantstats"}
NEW_W1 = {"/api/register", "/api/setup"}
NEW_W2 = {"/api/events", "/api/events/interests", "/api/godzinki", "/api/km/stats", "/api/admin/pending", "/api/klub",
          "/api/profile/notifications", "/api/basen/sessions", "/api/kurs/info", "/api/km/kursant-stats"}


def key(r):
    return r["u"] if r["fn"] == "appapi" else r["fn"]


def opens(after):
    out = []
    for r in req:
        if after:
            if r["fn"] != "appapi" or r.get("u") != "/api/register":
                continue
            w1, w2 = NEW_W1, NEW_W2
        else:
            if r["fn"] != "registeruser" or r["T"] < T0 or (SWITCH and r["T"] >= SWITCH):
                continue
            w1, w2 = OLD_W1, OLD_W2
        first = {}
        for x in req:
            if r["T"] - 3 <= x["T"] <= r["T"] + 20 and key(x) in (w1 | w2):
                first.setdefault(key(x), x)
        g = list(first.values())
        a = [x for x in g if key(x) in w1]
        b = [x for x in g if key(x) in w2]
        cold = [x for x in g if x["cold"]]
        out.append({
            "wait": max(x["lat"] for x in a) + max([x["lat"] for x in b] or [0]),
            "cold": bool(cold),
            "cold_idle": any(x["inst"] not in deploy_inst for x in cold),
            "c1": any(x["cold"] for x in a), "c2": any(x["cold"] for x in b),
        })
    return out


def q(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, int(p * len(v)))] if v else None


def report(name, o):
    n = len(o)
    c = [x for x in o if x["cold"]]
    w = [x for x in o if not x["cold"]]
    both = [x for x in o if x["c1"] and x["c2"]]
    print(f"\n== {name}: {n} otwarć")
    print(f"  z zimnym startem: {len(c)} ({100 * len(c) // max(1, n)}%), w tym obie fale zimne: {len(both)}")
    print(f"  czekanie na serwer — ciepłe: mediana {q([x['wait'] for x in w], .5)} ms, p90 {q([x['wait'] for x in w], .9)}"
          f" | zimne: mediana {q([x['wait'] for x in c], .5)} ms, p90 {q([x['wait'] for x in c], .9)}")
    print(f"  średnie czekanie (wszystkie otwarcia): {round(sum(x['wait'] for x in o) / max(1, n))} ms")
    if any("cold_idle" in x for x in o):
        ci = [x for x in o if x["cold_idle"]]
        print(f"  zimne z bezczynności (bez startów po wdrożeniu): {len(ci)} ({100 * len(ci) // max(1, n)}%)")


report("PRZED (osobne funkcje)", opens(False))
report("PO (appApi)", opens(True))

# Moduły po konsolidacji: udział zimnych żądań
GROUPS = {"sprzęt": "/api/gear", "km": "/api/km", "zarząd": "/api/admin", "basen": "/api/basen", "blachy": "/api/blachy",
          "publiczne": ("/api/public", "/api/kurs/zgloszenie")}
print("\n== PO — żądania według modułów (appapi)")
for g, pref in GROUPS.items():
    rs = [r for r in req if r["fn"] == "appapi" and (r.get("u") or "").startswith(pref)]
    c = [r for r in rs if r["cold"]]
    print(f"  {g}: {len(rs)} żądań, zimne {len(c)} ({100 * len(c) // max(1, len(rs))}%)")
app = [r for r in req if r["fn"] == "appapi"]
print(f"\nOkno PO: {D.datetime.fromtimestamp(app[0]['T'], D.UTC):%Y-%m-%d %H:%M} – {D.datetime.fromtimestamp(app[-1]['T'], D.UTC):%H:%M} UTC, "
      f"instancji appapi: {len({r['inst'] for r in app})}, wdrożeń (rewizji): {len(first_by_rev)}")
