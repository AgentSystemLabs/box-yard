import base64,sys,re,html,os
r=sys.argv[1]; d=f"/tmp/ux/round-{r}"; extra=open(sys.argv[2]).read() if len(sys.argv)>2 else ""
prev=f"/tmp/ux/round-{int(r)-1}"
items=[re.match(r"- (\S+): (.*)",l).groups() for l in open(d+"/SHOTS.md") if l.startswith("- ")]
img=lambda p:f"<img style='max-width:100%;max-height:800px' src='data:image/png;base64,{base64.b64encode(open(p,'rb').read()).decode()}'>"
seen=set();h=[f"<html><body style='background:#111;color:#ddd;font-family:sans-serif'><h1>Palette &amp; New task UX: round {r}</h1><pre>{html.escape(open('/tmp/ux/scores.md').read())}</pre><div>{extra}</div>"]
for f,c in items:
  if f in seen: continue
  seen.add(f); before=f"{prev}/{f}"
  pair=(f"<div style='display:flex;gap:8px'><div style='flex:1'><b>before</b><br>{img(before)}</div><div style='flex:1'><b>after</b><br>{img(d+'/'+f)}</div></div>" if os.path.exists(before) else img(d+'/'+f))
  h.append(f"<figure style='margin:8px;border-top:1px solid #333'>{pair}<figcaption>{f}: {c}</figcaption></figure>")
open(f"/tmp/ux/report-round-{r}.html","w").write("".join(h)+"</body></html>")
