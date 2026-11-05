import { ReleasePoller } from '../public/clock.js';
// A separate client process prevents the load generator's thousands of promises
// and JSON decodes from delaying the observer's own clock/timers.
let maxRtt=0,observed=false;
const poller=new ReleasePoller({fetchStatus:async()=>{const r=await fetch(process.env.FLASH_OBSERVE_URL);if(!r.ok)throw Error('HTTP '+r.status);return r.json();},
  onUpdate:(value,metrics)=>{maxRtt=Math.max(maxRtt,metrics.rtt);if(value.has_stock&&!observed){observed=true;process.send({observed:Date.now(),max_rtt_ms:Math.round(maxRtt)});}},
  onError:e=>process.send({error:e.message}),
});
poller.start();
process.on('message',m=>{if(m==='stop'){poller.stop();process.exit(0);}});
