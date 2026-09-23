import fs from "node:fs"; import path from "node:path";
const env = Object.fromEntries(fs.readFileSync(path.join(process.cwd(),".env.local"),"utf8").split(/\r?\n/).filter(l=>l&&!l.startsWith("#")&&l.includes("=")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^"|"$/g,"")];}));
const H={apikey:env.SUPABASE_SECRET_KEY,Authorization:`Bearer ${env.SUPABASE_SECRET_KEY}`,"Content-Profile":env.SUPABASE_SCHEMA,"Accept-Profile":env.SUPABASE_SCHEMA,"Content-Type":"application/json"};
const call=async(m)=>(await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/daily_pnl`,{method:"POST",headers:H,body:JSON.stringify({p_mode:m})})).json();
const perf=await call("performance"), act=await call("actual");
const COLS=["orders_placed","orders_resolved","delivered_count","items_sold","revenue","cogs","packaging","bosta_penalty","bosta_fees_paid","cod_cash_fee","open_package_fee","shipping_fee_charged"];
const months=["2026-02","2026-03","2026-04","2026-05","2026-06","2026-07"];
const sum=(rows,mo,k)=>rows.filter(r=>r.day.startsWith(mo)).reduce((a,r)=>a+Number(r[k]||0),0);
console.log("Column".padEnd(22)+months.map(m=>m.slice(5)+"  P vs A").map(s=>s.padStart(22)).join(""));
for(const k of COLS){
  let line=k.padEnd(22);
  for(const mo of months){
    const p=sum(perf,mo,k), a=sum(act,mo,k);
    const same=Math.abs(p-a)<0.005;
    line+=`${(Math.round(p*100)/100)+" / "+(Math.round(a*100)/100)+(same?" =":" X")}`.padStart(22);
  }
  console.log(line);
}
console.log("\n('=' identical between modes, 'X' differs)");
