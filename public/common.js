export const paths={
  grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  calendar:'M8 2v4 M16 2v4 M3 10h18 M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2z M7 14h2 M12 14h2 M7 18h2',
  ticket:'M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4z M15 5v3 M15 11v2 M15 16v3',
  users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M22 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75',
  scan:'M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M6 12h12 M8 8h1 M15 8h1 M8 16h1 M15 16h1',
  box:'m3 7 9-5 9 5v10l-9 5-9-5z M3 7l9 5 9-5 M12 12v10 M7 4.5l10 5.5',
  bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4',
  shield:'m12 3 8 3v6c0 5-8 10-8 10S4 17 4 12V6z m-4 9 3 3 5-5',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 3-1 3-6 3-3-2-3-1-3-6 2-3 1-3z',
  file:'M14 2H4v20h16V8z M14 2v6h6 M8 12h8 M8 16h8',
  store:'M3 10h18 M4 10v11h16V10 M2 10l2-7h16l2 7 M8 10l1-7 M16 10l-1-7 M9 21v-7h6v7',
  plus:'M12 5v14 M5 12h14',chevron:'m9 5 7 7-7 7',down:'m6 9 6 6 6-6',left:'m15 5-7 7 7 7',
  search:'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15 M16 16l5 5',
  arrow:'M5 12h14 M13 6l6 6-6 6',external:'M15 3h6v6 M10 14 21 3 M21 14v7H3V3h7',
  download:'M12 3v12 M7 10l5 5 5-5 M3 16v5h18v-5',refresh:'M20 7V2l-3 3A9 9 0 0 0 2 11 M4 17v5l3-3a9 9 0 0 0 15-6 M20 2h-5 M4 22h5',
  clock:'M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',check:'m5 12 4 4L19 6',close:'m6 6 12 12 M6 18 18 6',
  more:'M5 12h.01 M12 12h.01 M19 12h.01',help:'M9 9a3 3 0 1 1 5 2c-2 1-2 1-2 3 M12 17h.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  phone:'M6 2h12v20H6z M10 18h4',pause:'M8 5v14 M16 5v14',play:'m8 4 12 8-12 8z',
  logout:'M9 3H3v18h6 M9 12h12 M17 7l5 5-5 5',menu:'M4 6h16 M4 12h16 M4 18h16',
  leaf:'M20 3c0 12-1 17-10 17S1 10 8 6c4-2 8 0 12-3 M4 21 16 9',edit:'m15 4 5 5 M4 20l5-1L22 6l-5-5L4 14z',
  lock:'M5 10h14v12H5z M8 10V6a4 4 0 0 1 8 0v4 M12 15v3',info:'M12 11v6 M12 7h.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
};
export const icon=(name,cls='')=>`<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.grid}"/></svg>`;
export const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function api(path,method='GET',body,token) {
  let r;try{r=await fetch(path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(8000)});}catch{throw new Error('网络连接中断，请检查网络后重试');}
  const value=await r.json();if(!r.ok){const e=new Error(value.error||'请求失败');e.status=r.status;e.code=value.code;throw e;}return value;
}
export const date=(ts,style='full')=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',...(style==='day'?{month:'2-digit',day:'2-digit'}:style==='time'?{hour:'2-digit',minute:'2-digit',hour12:false}:{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}).format(ts);
export const localInput=ts=>new Date(ts+8*3600000).toISOString().slice(0,16);
export const parseInput=s=>new Date(s+':00+08:00').getTime();
export const statusNames={draft:'草稿',upcoming:'待开抢',live:'进行中',ended:'已结束',reserved:'待核销',redeemed:'已核销',paused:'已暂停',pending:'待发送',sending:'送达待确认',sent:'已发送',failed:'发送失败',expired:'已过期',blocked:'已封禁'};
export const status=s=>`<span class="status ${esc(s)}">${statusNames[s]||esc(s)}</span>`;
let toastTimer;
export function toast(message,error=false){const el=document.querySelector('#toast');if(!el)return;el.textContent=message;el.className='show'+(error?' error':'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.className='',4000);}
export async function exportFile(path,method='GET') {
  const r=await fetch(path,{method});if(!r.ok){const e=await r.json();throw new Error(e.error);}
  const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=r.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1]||'export.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
