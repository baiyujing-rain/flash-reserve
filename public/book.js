import {icon,esc,api,date,status,toast} from './common.js';
import {ReleasePoller} from './clock.js';
const $=s=>document.querySelector(s);
let config,event=null,events=[],slotId='',user=null,token=sessionStorage.getItem('flash_user_token'),poller=null,lastShape='',busy=false,online=true,agreed=false,view='event',records=[];
const initialEvent=new URLSearchParams(location.search).get('event');
const userApi=(path,method='GET',body)=>api(path,method,body,token);
function close(){document.querySelector('#modal-root').innerHTML='';}
function modal(title,body){$('#modal-root').innerHTML=`<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header class="modal-header"><h2>${title}</h2><button data-action="close" aria-label="关闭">${icon('close')}</button></header><div class="modal-body">${body}</div></section></div>`;$('#modal-root input')?.focus();}
function layout(body,bottom=''){
  $('#book-app').innerHTML=`<main class="booking-shell"><header class="booking-top"><a class="booking-wordmark" href="/book"><img src="/mark.svg" alt="山屿">${esc(config.store_name)}</a><button data-action="my">${icon('ticket')}我的预约</button></header>${config.demo?'<div class="booking-demo">本地演示 · 活动仅用于体验，非真实门店活动</div>':''}<div id="network-state"></div>${body}${bottom}</main>`;networkState();
}
function hero(){return event?.banner?`<div class="booking-hero has-banner"><img src="${esc(event.banner)}" alt="${esc(event.name)}"></div>`:`<section class="booking-hero"><div class="intro">一份期待，一场相遇</div><h1>好物限时<br>如约而至</h1><p>在这里，遇见生活的小小惊喜。</p><img src="/storefront.svg" alt="快闪门店插画"></section>`;}
function networkState(){const el=$('#network-state');if(el)el.innerHTML=online?'':`<div class="booking-network">${icon('info')}连接中断，正在自动重连。恢复后将更新号源。</div>`;}
function drawList(){poller?.stop();event=null;view='list';layout(hero()+`<div class="booking-content"><section class="booking-section"><h2>门店活动</h2><p>挑一场喜欢的活动，留一个见面的名额。</p>${events.length?events.map(e=>`<button class="booking-event-card" data-action="open-event" data-id="${e.id}"><div class="poster-thumb ${esc(e.theme)}">${esc(e.name.slice(0,2))}<br>快闪</div><div><strong>${esc(e.name)}</strong><small>${date(e.release_at)} 开抢 · ${e.total} 个名额</small></div>${status(e.phase)}${icon('chevron')}</button>`).join(''):`<div class="booking-empty">${icon('leaf')}<p>下一场相遇正在准备中，<br>活动发布后会显示在这里。</p></div>`}</section><p class="booking-meta">门店预约 · 到店核销 · 如约相见</p></div>`);}
function drawEvent(){
  view='event';if(!event)return;
  const before=event.phase==='upcoming';
  if(!event.slots.some(s=>s.id===slotId))slotId=event.slots.find(s=>!s.paused)?.id||event.slots[0]?.id||'';
  layout(hero()+`<div class="booking-content"><button class="booking-back" data-action="all-events">${icon('left')}全部门店活动</button><section class="booking-section"><div class="booking-event-top">${status(event.phase)}<span>每人限约 ${event.per_limit} 个</span></div><h2>${esc(event.name)}${event.demo?'<span class="demo-mini">演示</span>':''}</h2><p>${icon('store')}${esc(event.location)}</p><p>${icon('calendar')}${date(event.starts_at)} — ${date(event.ends_at)}</p><div class="release-hint"><div class="clock-label">${before?'距开放预约还有':event.phase==='ended'?'本场活动已结束':'号源实时更新'}</div><div class="time" id="release-clock">${before?'-- : -- : --':event.phase==='ended'?'下次见':'如约相见'}</div><div class="fine">${before?'到点自动开放，请停留在本页':'无需刷新页面，余量自动更新'}</div></div></section><section class="booking-section"><h3>选择入场时段</h3>${event.slots.map(s=>`<button class="booking-slot ${slotId===s.id?'selected':''}" data-action="select-slot" data-id="${s.id}" ${s.paused||s.ends_at<event.server_now?'disabled':''}><span><strong>${esc(s.label)}</strong><small>${date(s.starts_at)} — ${date(s.ends_at)}</small></span><span class="slot-stock">${s.paused?'暂停放号':s.available?'余 '+s.available+' 个':'暂无号源'}</span></button>`).join('')}</section><section class="booking-section"><h3>预约须知</h3><div class="booking-notices">${esc(event.notices||'请在预约时段到店，凭购买码核销。')}</div></section><label class="booking-agree"><input id="agreed" type="checkbox" ${agreed?'checked':''}>我已阅读预约须知，同意仅本人预约与到店核销。手机号仅用于本次预约及到店确认。</label><p class="booking-meta">${user?.phone?'已登录 · '+esc(user.phone.replace(/(\d{3})\d{4}(\d{4})/,'$1****$2')):'预约前需要微信登录并授权手机号'}<br>山屿快闪，让每一次期待都有回响。</p></div>`,`<footer class="booking-bottom"><div class="availability"><strong id="stock-count">0</strong>个名额<small id="stock-message">正在同步号源</small></div><button class="btn primary" id="book-button" data-action="book" disabled>正在同步</button></footer>`);
  updateAvailability();updateClock();
}
function updateAvailability(){if(!event||view!=='event')return;const slot=event.slots.find(s=>s.id===slotId),button=$('#book-button');if(!button)return;
  $('#stock-count').textContent=slot?.available??0;
  const ready=event.phase==='live'&&slot?.has_stock&&online;
  button.textContent=busy?'预约中…':!online?'连接恢复中':event.phase==='ended'?'活动已结束':event.phase==='upcoming'?'即将开抢':slot?.paused?'已暂停放号':ready?'立即预约':'暂无号源';
  button.disabled=busy||!ready;
  $('#stock-message').textContent=event.phase==='upcoming'?'开抢后自动更新':slot?.paused?'等待门店恢复':ready?'号源已开放，可预约':'等待补放号源';
}
function updateClock(){if(!event||view!=='event'||event.phase!=='upcoming')return;const el=$('#release-clock');if(!el)return;const n=Math.max(0,Math.ceil((event.release_at-(poller?.now()||event.server_now))/1000));el.textContent=[Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(n=>String(n).padStart(2,'0')).join(' : ');}
async function openEvent(id){
  poller?.stop();lastShape='';slotId='';agreed=false;
  event=await api('/api/public/events/'+id);history.replaceState(null,'','/book?event='+id);drawEvent();
  poller=new ReleasePoller({fetchStatus:()=>api('/api/public/events/'+id),onUpdate(value){
    online=true;event=value;const shape=JSON.stringify([value.phase,value.name,value.notices,value.location,value.banner,value.release_at,value.starts_at,value.ends_at,value.slots.map(s=>[s.id,s.label,s.available,s.paused,s.has_stock])]);
    if(shape!==lastShape&&view==='event'){lastShape=shape;drawEvent();}else{networkState();updateAvailability();}
  },onError(e){online=false;networkState();updateAvailability();if(e.status===404){poller.stop();toast('活动已下线，请返回活动列表',true);}}});poller.start();
}
async function ensureUser(){
  if(token){try{user=await userApi('/api/user/me');return;}catch(e){if(e.status!==401&&e.status!==403)throw e;token=null;sessionStorage.removeItem('flash_user_token');}}
  if(!config.demo){modal('请从微信小程序预约',`<p class="guide">正式预约需在微信小程序内登录并授权手机号。当前页面可查看活动信息；请在微信中打开门店小程序完成预约。</p>`);return false;}
  let id=sessionStorage.getItem('flash_demo_id');if(!id){id=crypto.randomUUID();sessionStorage.setItem('flash_demo_id',id);}
  const r=await api('/api/user/login','POST',{demo_id:id});token=r.token;user=r.user;sessionStorage.setItem('flash_user_token',token);
}
async function book(){
  if(!agreed){toast('请先阅读并勾选预约须知',true);return;}
  if(!event?.slots.find(s=>s.id===slotId)?.has_stock)return;
  if(busy)return;busy=true;updateAvailability();
  try{
    if(await ensureUser()===false)return;
    if(!user.phone){modal('授权预约手机号',`<div class="notice warning">${icon('info')}本地演示：可填写测试手机号。正式小程序通过微信授权验证手机号。</div><form id="phone-form"><div class="field"><label for="demo-phone">测试手机号</label><input id="demo-phone" name="phone" type="tel" inputmode="numeric" maxlength="11" pattern="1[0-9]{10}" required placeholder="输入 11 位测试手机号"></div><p class="form-error"></p><div class="form-footer"><button class="btn primary" type="submit">确认并预约</button></div></form>`);return;}
    const storageKey='flash_request_'+slotId;let key=sessionStorage.getItem(storageKey);if(!key){key=crypto.randomUUID();sessionStorage.setItem(storageKey,key);}
    await userApi('/api/user/reservations','POST',{slot_id:slotId,request_key:key});sessionStorage.removeItem(storageKey);
    toast('预约成功，购买码已生成');await myReservations();
  }catch(e){toast(e.message,true);if(e.status===401){token=null;sessionStorage.removeItem('flash_user_token');}}
  finally{busy=false;updateAvailability();}
}
async function myReservations(){
  if(await ensureUser()===false)return;
  poller?.stop();records=(await userApi('/api/user/reservations')).items;view='my';
  layout(`<div class="booking-content"><button class="booking-back" data-action="all-events">${icon('left')}返回门店活动</button><h2 class="booking-my-title">我的预约</h2><p class="booking-note">到店时出示完整购买码，请勿转发给他人。</p>${records.length?records.map(r=>`<section class="booking-ticket ${r.status==='redeemed'?'ticket-redeemed':''}"><div class="ticket-top">${icon(r.status==='redeemed'?'check':'ticket')}<h2>${r.status==='redeemed'?'已到店核销':'预约成功，如约相见'}</h2><p>${esc(r.event_name)}</p></div><div class="ticket-body"><div class="ticket-number">#${String(r.number).padStart(3,'0')}<small>你的入场号码</small></div><button class="purchase-code" data-action="copy" data-code="${r.code}">${r.code.slice(0,10)}<br>${r.code.slice(10)}<small>20 位唯一购买码 · 点击复制</small></button><div class="ticket-row"><span>预约场次</span><strong>${esc(r.slot_label)}</strong></div><div class="ticket-row"><span>入场时间</span><strong>${date(r.starts_at)}</strong></div><div class="ticket-row"><span>到店地点</span><strong>${esc(r.location)}</strong></div><div class="ticket-row"><span>预约手机号</span><strong>${r.phone.replace(/(\d{3})\d{4}(\d{4})/,'$1****$2')}</strong></div><div class="ticket-row"><span>购买码状态</span><strong>${r.status==='redeemed'?'已核销':'待核销'}</strong></div></div></section>`).join(''):`<div class="booking-empty">${icon('ticket')}<h2>期待与你相遇</h2><p>还没有预约，去看看正在开放的活动吧。</p></div>`}<div class="booking-result-actions"><button class="btn" data-action="all-events">浏览活动</button><button class="btn primary" data-action="my">刷新购买码状态</button></div><p class="booking-meta">名额有限，感谢每一份期待。</p></div>`);
}
document.addEventListener('change',e=>{if(e.target.id==='agreed')agreed=e.target.checked;});
document.addEventListener('click',async e=>{const el=e.target.closest('[data-action]');if(!el)return;try{
  const a=el.dataset.action;
  if(a==='close')return close();if(a==='open-event')return await openEvent(el.dataset.id);
  if(a==='select-slot'){slotId=el.dataset.id;drawEvent();return;}
  if(a==='book')return await book();if(a==='my')return await myReservations();
  if(a==='all-events'){poller?.stop();events=(await api('/api/public/events')).items;history.replaceState(null,'','/book');return drawList();}
  if(a==='copy'){await navigator.clipboard.writeText(el.dataset.code);toast('购买码已复制');}
}catch(error){toast(error.message,true);}});
document.addEventListener('submit',async e=>{if(e.target.id!=='phone-form')return;e.preventDefault();const f=e.target,b=Object.fromEntries(new FormData(f)),button=f.querySelector('button');button.disabled=true;try{const r=await userApi('/api/user/phone','POST',b);user.phone=r.phone;close();await book();}catch(e){f.querySelector('.form-error').textContent=e.message;}finally{button.disabled=false;}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)poller?.stop();else if(view==='event')poller?.start();});
setInterval(updateClock,200);
try{config=await api('/api/config');if(initialEvent)await openEvent(initialEvent);else{events=(await api('/api/public/events')).items;drawList();}}catch(e){$('#book-app').innerHTML=`<div class="boot"><h2>暂时无法打开预约</h2><p>${esc(e.message)}</p><a class="btn" href="/book">返回活动列表</a></div>`;}
