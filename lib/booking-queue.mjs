import { Worker } from 'node:worker_threads';
import { AppError } from './store.mjs';

/** Keep durable writes off the HTTP loop and recover a failed writer. */
export function bookingQueue(filename,{createWorker=()=>new Worker(new URL('./booking-worker.mjs',import.meta.url),{workerData:{filename}}),restartDelay=1000}={}){
  const jobs=new Map();let sequence=0,worker,ready=false,closed=false,restartTimer;
  const unavailable=()=>new AppError(503,'预约服务暂不可用，请稍后重试','BOOKING_UNAVAILABLE');
  function rejectPending(){ready=false;for(const job of jobs.values())job.reject(unavailable());jobs.clear();}
  function launch(){
    if(closed)return;
    const current=createWorker();worker=current;
    current.on('message',reply=>{
      if(closed||current!==worker)return;
      if(reply.ready){ready=true;return;}
      const job=jobs.get(reply.id);if(!job)return;jobs.delete(reply.id);
      if(reply.error)job.reject(new AppError(reply.error.status,reply.error.message,reply.error.code));else job.resolve(reply.value);
    });
    current.on('error',e=>{console.error('Booking worker:',e.message);if(current===worker)rejectPending();});
    current.on('exit',()=>{if(current!==worker)return;rejectPending();worker=null;if(!closed){restartTimer=setTimeout(launch,restartDelay);restartTimer.unref?.();}});
  }
  launch();
  return {
    healthy(){return ready&&!closed;},
    reserve(userId,body,ip){
      if(!this.healthy())return Promise.reject(unavailable());
      if(jobs.size>=2000)return Promise.reject(new AppError(429,'当前预约较多，请稍后重试','QUEUE_FULL'));
      return new Promise((resolve,reject)=>{const id=++sequence;jobs.set(id,{resolve,reject});worker.postMessage({id,userId,body,ip});});
    },
    close(){closed=true;clearTimeout(restartTimer);rejectPending();return worker?.terminate();},
  };
}
