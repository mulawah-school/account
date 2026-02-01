export async function api(url, method="GET", body=null){
  const opt = { method, headers: {} };
  if(body){
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(url, opt);
  const data = await r.json().catch(()=> ({}));
  if(!r.ok) throw new Error(data.error || "Request failed");
  return data;
}

export function qs(id){ return document.querySelector(id); }

export function toFromToDefault(){
  const now = new Date();
  const from = new Date(now); from.setHours(0,0,0,0);
  const to = new Date(now); to.setHours(23,59,59,0);
  const f = from.toISOString().slice(0,19).replace("T"," ");
  const t = to.toISOString().slice(0,19).replace("T"," ");
  return { f, t };
}
