import json, collections, statistics as S, datetime as D
req=json.load(open("req.json"))
def ts(s): return D.datetime.fromisoformat(s.replace("Z","").split(".")[0]+"."+(s.split(".")[1].rstrip("Z")+"000000")[:6]) if "." in s else D.datetime.fromisoformat(s.rstrip("Z"))
for r in req: r["T"]=ts(r["t"]).timestamp()
req=[r for r in req if r["m"] in ("GET","POST") and r["lat"] is not None]
req.sort(key=lambda r:r["T"])
seen=set()
for r in req:
    r["cold"]= r["inst"] not in seen if r["inst"] else False
    if r["inst"]: seen.add(r["inst"])
# first request of instances that existed before window are wrongly 'cold' only for first day; ignore first 2h
t0=req[0]["T"]+7200
START={"getsetup","geteventinterests","getevents","getgodzinki","kmmystats","getadminpending","getklubinfo","notificationprefs","getbasensessions","basenapi","getkursinfo","getkursantstats"}
def q(v,p): v=sorted(v); return v[min(len(v)-1,int(p*len(v)))] if v else None
# gap analysis per fn: time since previous request to same fn, cold vs warm
last={}; gc=[]; gw=[]
for r in req:
    if r["T"]<t0: last[r["fn"]]=r["T"]; continue
    g=(r["T"]-last[r["fn"]])/60 if r["fn"] in last else None
    last[r["fn"]]=r["T"]
    if g is None: continue
    (gc if r["cold"] else gw).append(g)
print("gap(min) before COLD: p10 %.1f p50 %.1f | before WARM: p50 %.1f p90 %.1f p99 %.1f"%(q(gc,.1),q(gc,.5),q(gw,.5),q(gw,.9),q(gw,.99)))
for G in (5,10,15,20):
    print(" G",G,"warm-with-gap>G:",sum(1 for g in gw if g>G),"cold-with-gap<=G:",sum(1 for g in gc if g<=G), "of cold",len(gc))
# app opens
opens=[]
byip=collections.defaultdict(list)
for r in req: byip[r["ip"]].append(r)
for r in req:
    if r["fn"]!="registeruser" or r["T"]<t0: continue
    grp=[x for x in byip[r["ip"]] if r["T"]-3<=x["T"]<=r["T"]+25 and (x["fn"] in START or x is r)]
    reg=[x for x in grp if x["fn"] in ("registeruser","getsetup")]
    home=[x for x in grp if x["fn"] not in ("registeruser","getsetup")]
    T=max(x["lat"] for x in reg)+ (max(x["lat"] for x in home) if home else 0)
    opens.append({"T":r["T"],"wall":T,"anycold":any(x["cold"] for x in grp),"ncold":sum(x["cold"] for x in grp),"n":len(grp),"fns":{x["fn"] for x in grp}})
print("app opens:",len(opens), "with >=1 cold:",sum(o["anycold"] for o in opens))
w=[o["wall"] for o in opens if not o["anycold"]]; c=[o["wall"] for o in opens if o["anycold"]]
print("server wait (reg/setup + home) WARM opens median %d p90 %d | COLD opens median %d p90 %d"%(q(w,.5),q(w,.9),q(c,.5),q(c,.9)))
print("cold count per cold open:",collections.Counter(o["ncold"] for o in opens if o["anycold"]))
# simulate merged group: register+setup+START into one fn; warm if any group request within G min before
grpfns=START|{"registeruser"}
for G in (10,15):
    lastg=None; simcold=0
    times=[r["T"] for r in req if r["fn"] in grpfns]
    tset=sorted(times)
    import bisect
    for o in opens:
        i=bisect.bisect_left(tset,o["T"]-3)
        prev=tset[i-1] if i>0 else None
        if prev is None or (o["T"]-3-prev)/60>G: simcold+=1
    print("SIM merged G=%d: opens with cold start %d / %d"%(G,simcold,len(opens)))
# per day users
days=collections.Counter(D.datetime.utcfromtimestamp(o["T"]).strftime("%m-%d") for o in opens)
print(sorted(days.items()))
print("----")
k=0
for o in opens:
    if o["anycold"] and k<3:
        k+=1
        for x in byip and [x for x in req if abs(x["T"]-o["T"])<=25]:
            print(round(x["T"]-o["T"],1), x["fn"], x["lat"], "COLD" if x["cold"] else "", x["inst"], x["ip"][-6:])
        print()
