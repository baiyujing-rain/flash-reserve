import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ReleasePoller } from '../public/clock.js';
const require=createRequire(import.meta.url);
const NativePoller=require('../miniprogram/utils/clock.js').ReleasePoller;
const flush=()=>new Promise(resolve=>setImmediate(resolve));
for(const [name,Poller] of [['H5',ReleasePoller],['微信原生',NativePoller]]){
  test(`${name}: 80ms RTT 模拟开抢后 1 秒内自动切换`,async()=>{
    let mono=0,schedule,observed=null;const release=1000000+3000;
    const p=new Poller({monoNow:()=>mono,setTimer:(fn,delay)=>{schedule={fn,delay};return 1;},clearTimer:()=>{},
      fetchStatus:async()=>{mono+=80;return {server_now:1000000+mono-40,release_at:release,has_stock:1000000+mono-40>=release};},
      onUpdate:v=>{if(v.has_stock&&observed===null)observed=1000000+mono;}});
    p.start();await flush();
    assert.equal(p.now(),1000080);assert.equal(p.interval(),300);
    while(observed===null&&mono<5000){mono+=schedule.delay;await schedule.fn();}
    assert.ok(observed-release>=0);assert.ok(observed-release<1000,`延迟 ${observed-release}ms`);p.stop();
  });
  test(`${name}: 补放库存即使过了抢号窗口也在 700ms 周期检查`,async()=>{let mono=50000,schedule;const p=new Poller({monoNow:()=>mono,setTimer:(fn,delay)=>{schedule={fn,delay};return 1;},clearTimer:()=>{},fetchStatus:async()=>({server_now:mono,release_at:1000}),onUpdate:()=>{}});p.start();await flush();assert.equal(p.interval(),700);assert.equal(schedule.delay,700);p.stop();});
  test(`${name}: 慢请求不重叠，页面退出后丢弃旧响应`,async()=>{let resolve,calls=0,updates=0;const p=new Poller({monoNow:()=>0,setTimer:()=>{throw Error('stopped poller scheduled');},clearTimer:()=>{},fetchStatus:()=>{calls++;return new Promise(r=>resolve=r);},onUpdate:()=>updates++});p.start();p.start();assert.equal(calls,1);p.stop();resolve({server_now:0,release_at:1000});await flush();assert.equal(updates,0);});
}
