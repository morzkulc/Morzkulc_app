import json, collections, bisect
exec(open("analyze.py").read().split("# app opens")[0])
regs=[r for r in req if r["fn"]=="registeruser" and r["T"]>=t0]
opens=[]
for r in regs:
    grp=[x for x in req if r["T"]-3<=x["T"]<=r["T"]+20 and x["fn"] in START|{"registeruser"}]
    # only first occurrence per fn (home fan-out)
    first={}
    for x in grp:
        first.setdefault(x["fn"],x)
    grp=list(first.values())
    tier1=[x for x in grp if x["fn"] in ("registeruser","getsetup")]
    tier2=[x for x in grp if x["fn"] not in ("registeruser","getsetup")]
    t1=max(x["lat"] for x in tier1); t2=max([x["lat"] for x in tier2] or [0])
    c1=any(x["cold"] for x in tier1); c2=any(x["cold"] for x in tier2)
    opens.append(dict(T=r["T"],wall=t1+t2,t1=t1,t2=t2,c1=c1,c2=c2))
n=len(opens)
def med(v,p=.5): return q(v,p)
grp=collections.defaultdict(list)
for o in opens: grp[(o["c1"],o["c2"])].append(o)
for k,v in sorted(grp.items()):
    print("tier1 cold=%s tier2 cold=%s: %d opens, server wait median %d ms, p90 %d (t1 %d + t2 %d)"%(k[0],k[1],len(v),med([o["wall"] for o in v]),med([o["wall"] for o in v],.9),med([o["t1"] for o in v]),med([o["t2"] for o in v])))
# warm latency of tier2 and cold latency of tier1 to model merged
warm_t2=[o["t2"] for o in opens if not o["c2"]]
cold_t1=[o["t1"] for o in opens if o["c1"]]
warm_t1=[o["t1"] for o in opens if not o["c1"]]
print("model merged cold open = cold t1 median %d + warm t2 median %d = %d"%(med(cold_t1),med(warm_t2),med(cold_t1)+med(warm_t2)))
tset=sorted(r["T"] for r in req if r["fn"] in START|{"registeruser"})
for G in (15,):
    sc=0
    for o in opens:
        i=bisect.bisect_left(tset,o["T"]-3)
        if i==0 or (o["T"]-3-tset[i-1])/60>G: sc+=1
    print("now opens with cold: %d/%d ; merged sim (G=15): %d/%d"%(sum(o["c1"] or o["c2"] for o in opens),n,sc,n))
