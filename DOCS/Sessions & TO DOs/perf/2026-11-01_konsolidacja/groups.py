exec(open("analyze.py").read().split("# gap analysis")[0])
import collections
G={
 "sprzet":["getgearkayaks","getgearitems","getgearmyreservations","creategearreservation","createbundlegearreservation","updatebundlegearreservationitems","getgearitemavailability","submitgeardamagereport","updategearreservation","cancelgearreservation","getgearfavorites","gearfavoritetoggle","getkayakreservations"],
 "km":["kmaddlog","kmmylogs","kmrankings","kmplaces","kmeventstats","kmmapdata"],
 "godz/imprezy/profil":["submitgodzinki","purchasegodzinki","submitevent","eventinteresttoggle","userweight"],
 "zarzad":["adminputsetup","getadminpending","getadmingearrentals","getadmingeartoprentals","getadmingeardamagereports","getadminmemberactivity","getadminmemberdues","getadminuseractivity","admineventssynccalendar","adminapprove","adminreject","resolvegeardamagereport","adminkurszgloszenia","adminkurszgloszenieaction","adminblachy","kmadminmergeplaces","adminCancelGearReservation".lower(),"getbasenadmingodzinyusers","getbasenadmingodzinyhistory"],
 "blachy":["blachyapi"],
 "publiczne":["publicsiteinfo","kurszgloszenie"],
 "arkusze":["appsscriptsync"],
}
for g,fns in G.items():
    rs=[r for r in req if r["fn"] in fns and r["T"]>=t0]
    c=sum(r["cold"] for r in rs)
    cl=[r["lat"] for r in rs if r["cold"]]
    print(f"{g}: {len(rs)} żądań / 14 dni, zimne {c} ({100*c//max(1,len(rs))}%), mediana zimnego {q(cl,.5)} ms")
