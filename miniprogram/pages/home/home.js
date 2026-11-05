const {request,format}=require('../../utils/api');
Page({
  data:{events:[],error:'',demo:false,storeName:'山屿快闪',loaded:false},
  async onShow(){try{const [config,list]=await Promise.all([request('/api/config'),request('/api/public/events')]);getApp().globalData.publicConfig=config;this.setData({storeName:config.store_name,demo:config.demo,events:list.items.map(e=>({...e,releaseText:format(e.release_at),phaseText:{upcoming:'待开抢',live:'进行中',ended:'已结束'}[e.phase]})),error:'',loaded:true});}catch(e){this.setData({error:e.message,loaded:true});}},
  open(e){wx.navigateTo({url:'/pages/event/event?id='+e.currentTarget.dataset.id});},
  my(){wx.navigateTo({url:'/pages/tickets/tickets'});},
  privacy(){wx.navigateTo({url:'/pages/privacy/privacy'});},
});
