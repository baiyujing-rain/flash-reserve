const {request,login,format}=require('../../utils/api');
const {ReleasePoller}=require('../../utils/clock');
Page({
  data:{event:null,slots:[],slotId:'',available:0,ready:false,buttonText:'正在连接',countdown:'-- : -- : --',agreed:false,busy:false,phone:false,demo:false,error:'',templateId:'',upcoming:false,canRemind:false},
  onLoad(query){this.id=query.id;},
  async onShow(){
    if(!this.id){this.setData({error:'活动不存在'});return;}
    this.poller=new ReleasePoller({fetchStatus:()=>request('/api/public/events/'+this.id),onUpdate:e=>this.applyEvent(e),onError:e=>{this.setData({error:e.message,ready:false,buttonText:'连接恢复中'});}});
    this.poller.start();this.clock=setInterval(()=>this.updateCountdown(),200);
    try{const config=await request('/api/config');this.setData({demo:config.demo,templateId:config.template_id,canRemind:config.wechat&&!!config.template_id});const user=await login();this.setData({phone:!!user.phone});}catch(e){this.setData({error:e.message});}
  },
  onHide(){this.stop();},onUnload(){this.stop();},
  stop(){if(this.poller)this.poller.stop();clearInterval(this.clock);},
  applyEvent(e){
    const slotId=e.slots.some(s=>s.id===this.data.slotId)?this.data.slotId:(e.slots.find(s=>!s.paused)||e.slots[0]||{}).id;
    const slot=e.slots.find(s=>s.id===slotId),ready=e.phase==='live'&&!!slot&&slot.has_stock;
    this.setData({event:{...e,timeText:format(e.starts_at)+' — '+format(e.ends_at),releaseText:format(e.release_at)},slots:e.slots.map(s=>({...s,timeText:format(s.starts_at)+' — '+format(s.ends_at)})),slotId,available:slot?slot.available:0,ready,upcoming:e.phase==='upcoming',error:'',buttonText:this.data.busy?'预约中…':e.phase==='upcoming'?'即将开抢':e.phase==='ended'?'活动已结束':slot&&slot.paused?'已暂停放号':ready?'立即预约':'暂无号源'});
    this.updateCountdown();
  },
  updateCountdown(){const e=this.data.event;if(!e||!this.data.upcoming)return;const n=Math.max(0,Math.ceil((e.release_at-this.poller.now())/1000));const value=[Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(n=>String(n).padStart(2,'0')).join(' : ');if(value!==this.data.countdown)this.setData({countdown:value});},
  select(e){this.setData({slotId:e.currentTarget.dataset.id});this.applyEvent(this.data.event);},
  agree(e){this.setData({agreed:e.detail.value.includes('agree')});},
  privacy(){wx.navigateTo({url:'/pages/privacy/privacy'});},
  async phone(e){
    if(!this.data.agreed){wx.showToast({title:'请先同意预约须知',icon:'none'});return;}
    if(!e.detail.code){wx.showToast({title:'请授权手机号后预约',icon:'none'});return;}
    try{await login();await request('/api/user/phone','POST',{code:e.detail.code});this.setData({phone:true});await this.reserve();}catch(err){wx.showToast({title:err.message,icon:'none'});}
  },
  demoBook(){if(!this.data.agreed){wx.showToast({title:'请先同意预约须知',icon:'none'});return;}if(this.data.phone)return this.reserve();wx.showModal({title:'演示预约手机号',content:'仅本地演示，请输入测试手机号',editable:true,placeholderText:'11 位测试手机号',success:async r=>{if(!r.confirm)return;try{await login();await request('/api/user/phone','POST',{phone:r.content});this.setData({phone:true});await this.reserve();}catch(e){wx.showToast({title:e.message,icon:'none'});}}});},
  async reserve(){
    if(!this.data.agreed){wx.showToast({title:'请先阅读预约须知',icon:'none'});return;}
    if(this.data.busy||!this.data.ready)return;
    this.setData({busy:true});
    const keyName='flash_request_'+this.data.slotId;
    let requestKey=wx.getStorageSync(keyName);if(!requestKey){requestKey=Date.now().toString(36)+'_'+Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);wx.setStorageSync(keyName,requestKey);}
    try{await login();await request('/api/user/reservations','POST',{slot_id:this.data.slotId,request_key:requestKey});wx.removeStorageSync(keyName);wx.navigateTo({url:'/pages/tickets/tickets'});}
    catch(e){wx.showToast({title:e.message,icon:'none',duration:3000});}
    finally{this.setData({busy:false});}
  },
  remind(){
    // Must be called directly by the user gesture, before awaiting any network call.
    if(!this.data.templateId)return;
    const templateId=this.data.templateId;
    wx.requestSubscribeMessage({tmplIds:[templateId],success:async r=>{if(r[templateId]!=='accept')return;try{await login();await request('/api/user/reminders','POST',{event_id:this.id,accepted:true});wx.showToast({title:'已订阅开抢提醒',icon:'success'});}catch(e){wx.showToast({title:e.message,icon:'none'});}},fail(){wx.showToast({title:'订阅失败，请稍后重试',icon:'none'});}});
  },
});
