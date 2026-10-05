"""dump.py: the red cases of one baseline dispatch layer, each with its failing check ids; run directly it prints the reds grouped
by (row, scenario, failing set, reason shape).

    W1D_DISPATCH=<dir> python3 dump.py <dispatch 1|2|3> <layer L1|L2|L3>

<dir> holds the three baseline dispatches as <dir>/<n>/<layer>/results.json (Task 19 read them from its session scratch;
Task 21 commits them, and this reads the committed copy by the same layout)."""
import json, os, sys, re, collections
D = os.environ.get("W1D_DISPATCH")
if D is None:
    raise SystemExit("set W1D_DISPATCH to the directory holding <n>/<layer>/results.json for the three baseline dispatches")
def reds(run, layer):
    r=json.load(open(f"{D}/{run}/{layer}/results.json"))
    for c in r["cases"]:
        if c["state"]=="red":
            yield {**c, "failing":sorted(k["id"] for k in c["checks"] if k["verdict"]=="fail")}
if __name__=="__main__":
    run, layer = sys.argv[1], sys.argv[2]
    g=collections.defaultdict(list)
    for c in reds(run, layer):
        sig=re.sub(r"\d+","N",c["reason"])[:110]
        g[(c["row"], c["scenario"], tuple(c["failing"]), sig)].append(c)
    for k,v in sorted(g.items()):
        print(len(v), "|", k[0], "|", k[1], "|", ",".join(k[2]), "|", k[3], "| sports:", ",".join(sorted({c["sport"] for c in v}))[:80])
