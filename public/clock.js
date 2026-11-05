/** Plan A: midpoint server-time calibration anchored to a monotonic clock.
 * At most one request is in flight. Idle 700ms, release window 300ms.
 * A foreground page with RTT <300ms should observe release within 1 second.
 * Offline/OS-background pages cannot offer a hard network latency guarantee.
 */
export class ReleasePoller {
  constructor({fetchStatus,onUpdate,onError=()=>{},monoNow=()=>performance.now(),setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id)}) {
    Object.assign(this,{fetchStatus,onUpdate,onError,monoNow,setTimer,clearTimer});
    this.running=false;this.value=null;this.anchor=null;this.generation=0;this.timer=null;
  }
  now(){return this.anchor?this.anchor.server+(this.monoNow()-this.anchor.mono):Date.now();}
  interval(){if(!this.value)return 700;const d=this.now()-this.value.release_at;return d>=-10000&&d<=10000?300:700;}
  start(){if(this.running)return;this.running=true;this.generation++;this.tick(this.generation);}
  stop(){this.running=false;this.generation++;this.clearTimer(this.timer);}
  async tick(generation){
    const sent=this.monoNow();
    try{
      const value=await this.fetchStatus();
      if(!this.running||generation!==this.generation)return;
      const received=this.monoNow();
      this.anchor={server:value.server_now+(received-sent)/2,mono:received};this.value=value;
      this.onUpdate(value,{rtt:received-sent,serverNow:this.now()});
    }catch(error){if(!this.running||generation!==this.generation)return;this.onError(error);}
    if(this.running&&generation===this.generation){
      // Target request start-to-start cadence; a slow response cannot spawn overlapping requests.
      this.timer=this.setTimer(()=>this.tick(generation),Math.max(30,this.interval()-(this.monoNow()-sent)));
    }
  }
}
