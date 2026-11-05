function request(path, method = 'GET', data) {
  const app=getApp();
  return new Promise((resolve,reject)=>wx.request({url:app.globalData.config.baseUrl+path,method,data,timeout:5000,
    header:{'content-type':'application/json',...(app.globalData.token?{Authorization:'Bearer '+app.globalData.token}:{})},
    success(r){if(r.statusCode>=200&&r.statusCode<300)resolve(r.data);else{const e=new Error(r.data.error||'请求失败');e.status=r.statusCode;e.code=r.data.code;if(r.statusCode===401){app.globalData.token='';wx.removeStorageSync('flash_token');}reject(e);}},
    fail(){reject(new Error('网络连接中断，请检查网络，页面将自动重连'));},
  }));
}
let loginPromise=null;
function login(){
  if(loginPromise)return loginPromise;
  loginPromise=(async()=>{
    const app=getApp();
    if(app.globalData.token){try{const user=await request('/api/user/me');app.globalData.user=user;return user;}catch(e){if(e.status!==401&&e.status!==403)throw e;}}
    let payload;
    if(app.globalData.config.demo){let id=wx.getStorageSync('flash_demo_id');if(!id){id=Date.now().toString(36)+'_'+Math.random().toString(36).slice(2);wx.setStorageSync('flash_demo_id',id);}payload={demo_id:id};}
    else{const wxLogin=await new Promise((resolve,reject)=>wx.login({success:resolve,fail:reject}));if(!wxLogin.code)throw new Error('微信登录失败，请重新进入');payload={code:wxLogin.code};}
    const r=await request('/api/user/login','POST',payload);app.globalData.token=r.token;app.globalData.user=r.user;wx.setStorageSync('flash_token',r.token);return r.user;
  })().finally(()=>{loginPromise=null;});return loginPromise;
}
const format=ts=>{const d=new Date(ts+8*3600000);return `${d.getUTCMonth()+1}月${d.getUTCDate()}日 ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;};
module.exports={request,login,format};
