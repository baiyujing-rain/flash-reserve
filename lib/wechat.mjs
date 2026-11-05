import { fail } from './store.mjs';
export function wechatClient(env = process.env) {
  let cached = null;
  async function call(url, data) {
    const r = await fetch(url, { method: data?'POST':'GET',
      headers: data?{'Content-Type':'application/json'}:{}, body: data?JSON.stringify(data):undefined,
      signal: AbortSignal.timeout(8000) });
    if (!r.ok) fail(502, '微信服务暂不可用，请稍后重试', 'WECHAT_UNAVAILABLE');
    const value = await r.json();
    if (value.errcode) fail(502, `微信接口错误 ${value.errcode}，请检查账号权限和模板配置`, 'WECHAT_ERROR');
    return value;
  }
  function configured() { if (!env.WECHAT_APP_ID || !env.WECHAT_APP_SECRET) fail(503, '尚未配置微信 AppID 和 AppSecret', 'WECHAT_NOT_CONFIGURED'); }
  async function accessToken() {
    configured();
    if (cached && cached.expires>Date.now()) return cached.token;
    const data = await call('https://api.weixin.qq.com/cgi-bin/stable_token', { grant_type:'client_credential', appid:env.WECHAT_APP_ID, secret:env.WECHAT_APP_SECRET });
    if (!data.access_token) fail(502, '微信未返回访问凭证');
    cached = { token: data.access_token, expires:Date.now()+(data.expires_in-300)*1000 };
    return cached.token;
  }
  return {
    enabled: !!(env.WECHAT_APP_ID && env.WECHAT_APP_SECRET),
    async login(code) {
      configured();
      const q = new URLSearchParams({ appid:env.WECHAT_APP_ID, secret:env.WECHAT_APP_SECRET, js_code:code, grant_type:'authorization_code' });
      const r = await call(`https://api.weixin.qq.com/sns/jscode2session?${q}`);
      if (!r.openid) fail(502, '微信未返回用户身份');
      return r.openid;
    },
    async phone(code) {
      const token = await accessToken();
      const r = await call(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${token}`, { code });
      if (!r.phone_info?.purePhoneNumber) fail(502, '微信未返回手机号');
      return r.phone_info.purePhoneNumber;
    },
    async remind(user, event, settings) {
      const token = await accessToken();
      const format = new Intl.DateTimeFormat('zh-CN', { timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false });
      return call(`https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`, {
        touser:user.openid, template_id:settings.template_id,
        page:`pages/event/event?id=${event.id}`, miniprogram_state:'formal', lang:'zh_CN',
        data: { [settings.template_name_key]:{value:event.name.slice(0,20)},
          [settings.template_time_key]:{value:format.format(event.release_at).replace(/\//g,'-')},
          [settings.template_location_key]:{value:event.location.slice(0,20)} },
      });
    },
  };
}
