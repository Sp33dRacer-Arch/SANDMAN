const apiUrl=(process.env.API_URL||process.env.APP_URL||'http://localhost:4000').replace(/\/$/,'');
const key=(process.env.SANDMAN_VINYASA_SYNC_API_KEY||'').trim();
if(!key){console.error('SANDMAN_VINYASA_SYNC_API_KEY is required');process.exit(1);}
const mode=(process.argv.find(a=>a.startsWith('--mode='))?.split('=')[1]||'STOCK_PRICE').toUpperCase();
const maxRaw=process.argv.find(a=>a.startsWith('--max='))?.split('=')[1];
const allowed=new Set(['FULL','STOCK_PRICE','TRACKING','ALL']);
const body={mode:allowed.has(mode)?mode:'STOCK_PRICE',...(maxRaw?{maxProducts:Number(maxRaw)}:{})};
const controller=new AbortController();
const timeout=setTimeout(()=>controller.abort(),15*60_000);
try{
  const response=await fetch(`${apiUrl}/api/integrations/vinyasa/sync`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
  const payload=await response.json().catch(()=>null);
  if(!response.ok){console.error(payload?.error?.message||payload?.message||`Vinyasa sync failed (${response.status})`);process.exit(1);}
  console.log(JSON.stringify(payload,null,2));
}catch(error){console.error(error?.name==='AbortError'?'Vinyasa sync timed out':error?.message||error);process.exit(1);}finally{clearTimeout(timeout);}
