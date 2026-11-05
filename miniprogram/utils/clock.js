// Same release-window contract as public/clock.js; kept CommonJS for native WeChat.
class ReleasePoller {
  constructor({fetchStatus,onUpdate,onError=()=>{},monoNow,setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id)}) {
    Object.assign(this,{fetchStatus,onUpdate,onError,monoNow:monoNow||(()=>wx.getPerformance().now()),setTimer,clearTimer});
    this.running=false;this.value=null;this.anchor=null;this.generation=0;this.timer=null;
  }
  now(){return this.anchor?this.anchor.server+(this.monoNow()-this.anchor.mono):Date.now();}
  interval(){if(!this.value)return 700;const d=this.now()-this.value.release_at;return d>=-10000&&d<=10000?300:700;}
  start(){if(this.running)return;this.running=true;this.generation++;this.tick(this.generation);}
  stop(){this.running=false;this.generation++;this.clearTimer(this.timer);}
  async tick(generation){
    const sent=this.monoNow();
    try{const value=await this.fetchStatus();if(!this.running||generation!==this.generation)return;const received=this.monoNow();this.anchor={server:value.server_now+(received-sent)/2,mono:received};this.value=value;this.onUpdate(value,{rtt:received-sent,serverNow:this.now()});}
    catch(e){if(!this.running||generation!==this.generation)return;this.onError(e);}
    if(this.running&&generation===this.generation)this.timer=this.setTimer(()=>this.tick(generation),Math.max(30,this.interval()-(this.monoNow()-sent)));
  }
}
module.exports={ReleasePoller};
