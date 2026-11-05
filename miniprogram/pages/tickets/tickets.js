const {request,login,format}=require('../../utils/api');
Page({
  data:{items:[],error:'',loaded:false},
  async onShow(){try{await login();await this.refresh();}catch(e){this.setData({error:e.message,loaded:true});}},
  async refresh(){try{const r=await request('/api/user/reservations');this.setData({items:r.items.map(i=>({...i,timeText:format(i.starts_at),phoneText:i.phone.replace(/(\d{3})\d{4}(\d{4})/,'$1****$2'),numberText:String(i.number).padStart(3,'0'),codeTop:i.code.slice(0,10),codeBottom:i.code.slice(10)})),loaded:true,error:''});}catch(e){this.setData({error:e.message,loaded:true});}},
  copy(e){wx.setClipboardData({data:e.currentTarget.dataset.code});},
  home(){wx.reLaunch({url:'/pages/home/home'});},
});
