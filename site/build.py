"""Build index.html from site/template.html and data/experiment.json. Run from the repository root."""
import collections, json

d = json.load(open("data/experiment.json", encoding="utf-8"))
R = d["runs"]
ans = {k: [r["answer"] for r in R[k]] for k in ("slogan", "number", "capital", "replay")}
strip = lambda s: s.strip('"“”')
stem_n = sum(strip(a).lower().startswith("turning data into decisions,") for a in ans["slogan"])
fps = {r["foot"].split("fingerprint ")[-1] for r in R["replay"]}
assert len(fps) == 1 and len(set(ans["replay"])) == 1, "replays were not identical"
html = open("site/template.html", encoding="utf-8").read()
for key, value in {
    "__DATA__": json.dumps(ans, ensure_ascii=False).replace("</", "<\\/"),
    "__SLOGAN_DISTINCT__": len(set(ans["slogan"])),
    "__CAPITAL_DISTINCT__": len(set(ans["capital"])),
    "__NUMBER_N__": collections.Counter(ans["number"]).most_common(1)[0][1],
    "__STEM_N__": stem_n,
    "__REPLAY_FP__": fps.pop(),
    "__REPLAY_ANSWER__": ans["replay"][0].replace("&", "&amp;").replace("<", "&lt;"),
    "__TOTAL__": sum(len(v) for v in ans.values()),
}.items():
    html = html.replace(key, str(value))
assert "__" not in html.split("<script>")[0].replace("__DATA__", ""), "unfilled placeholder"
open("index.html", "w", encoding="utf-8").write(html)
print("built index.html:", {k: len(set(v)) for k, v in ans.items()}, "stem", stem_n)
