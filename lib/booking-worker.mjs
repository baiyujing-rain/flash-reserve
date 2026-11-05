import { parentPort, workerData } from 'node:worker_threads';
import { openStore, reserve } from './store.mjs';

const store=openStore(workerData.filename);
parentPort.postMessage({ready:true});
parentPort.on('message',job=>{
  try{
    const user=store.get('SELECT * FROM users WHERE id=?',job.userId);
    if(!user)throw Object.assign(new Error('请重新登录'),{status:401,code:'UNAUTHENTICATED'});
    store.rate('book:'+user.id,store.settings().booking_limit);
    const value=reserve(store,user,job.body,job.ip);
    parentPort.postMessage({id:job.id,value});
  }catch(e){parentPort.postMessage({id:job.id,error:{message:e.status?e.message:'预约服务暂不可用，请稍后重试',status:e.status||503,code:e.status?e.code:'BOOKING_UNAVAILABLE'}});}
});
