import fs from "node:fs"; import path from "node:path";
const env = Object.fromEntries(fs.readFileSync(path.join(process.cwd(),".env.local"),"utf8").split(/\r?\n/).filter(l=>l&&!l.startsWith("#")&&l.includes("=")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^"|"$/g,"")];}));
const H={apikey:env.SUPABASE_SECRET_KEY,Authorization:`Bearer ${env.SUPABASE_SECRET_KEY}`,"Content-Profile":env.SUPABASE_SCHEMA,"Accept-Profile":env.SUPABASE_SCHEMA,"Content-Type":"application/json"};
const rows=await (await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/daily_pnl`,{method:"POST",headers:H,body:JSON.stringify({p_mode:"performance"})})).json();
console.log("columns the LIVE daily_pnl returns:\n ", Object.keys(rows[0]).join("\n  "));
console.log("\nhas open_package_fee?", "open_package_fee" in rows[0]);
const r=rows.find(x=>x.day>="2026-07-01");
console.log("\nsample July row:", JSON.stringify(r,null,1));
