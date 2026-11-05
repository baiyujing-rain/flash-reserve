import { isIP } from 'node:net';
import { fail } from './store.mjs';

export function clientIp(req,trustProxy=false){
  const peer=req.socket.remoteAddress||'';
  if(!trustProxy)return peer;
  const header=req.headers['x-forwarded-for'];
  if(typeof header!=='string')return peer;
  // The trusted immediate proxy appends/replaces the last address.
  const last=header.split(',').at(-1).trim();
  return isIP(last)?last:peer;
}
export function passwordValue(value,min=1,max=200){
  if(typeof value!=='string'||value.length<min||value.length>max)fail(400,`密码长度应为 ${min}–${max} 个字符`);
  return value; // Passwords are opaque; whitespace is significant.
}
