import { openStore } from '../lib/store.mjs';
import { createApp } from '../lib/app.mjs';
const store=openStore(process.env.FLASH_LOAD_DB,{password:'isolated-load-test-only'});
const {server}=createApp(store,{demo:false,wechat:{enabled:false}});
server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port}));
process.on('message',m=>{if(m==='stop'){server.closeAllConnections();server.close(()=>{store.close();process.exit(0);});}});
