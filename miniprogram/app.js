const config = require('./config');
App({
  globalData: { config, token: '', user: null, publicConfig: null },
  onLaunch() { this.globalData.token = wx.getStorageSync('flash_token') || ''; },
});
