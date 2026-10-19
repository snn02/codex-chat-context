'use strict';
// Local QA only: real aggregate data, simulated MCP host. Never writes probe events.
const http=require('node:http');const crypto=require('node:crypto');
const {renderHtml}=require('../server.cjs');const {ContextCollector}=require('../lib/collector.cjs');
const {ContextFiles}=require('../lib/files.cjs');
const ids=process.argv.slice(2).filter(x=>/^[0-9a-f-]{36}$/.test(x));
if(!ids.length)throw Error('Pass one or two thread UUIDs to preview.');
const prefix='/'+crypto.randomBytes(12).toString('hex');const collector=new ContextCollector();
const files=new ContextFiles({collector});
const server=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://127.0.0.1');
  if(!url.pathname.startsWith(prefix+'/')){res.writeHead(404);res.end();return;}
  res.setHeader('Cache-Control','no-store');
  const tail=url.pathname.slice(prefix.length+1);
  if(tail==='') {
   res.setHeader('Content-Type','text/html; charset=utf-8');
   res.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Контекст — локальный предпросмотр</title><style>body{margin:0;background:#f3f3f0;font:14px system-ui;color:#555}nav{padding:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}select,button{font:inherit;padding:5px}iframe{display:block;margin:8px auto;width:540px;height:1250px;border:0;background:white;max-width:100%}.note{font-size:12px}</style><nav><b>Предпросмотр</b><span class="note">Реальные агрегаты · мост Codex имитируется</span><label>Чат <select id="chat">${ids.map((id,i)=>`<option value="${i}">${i+1} · ${id.slice(-8)}</option>`).join('')}</select></label><label>Ширина <select id="width"><option>540</option><option>360</option><option>800</option></select></label><button id="toggle">Скрыть панель</button><span id="requests">Запросов: 0</span></nav><iframe title="Панель контекста" id="panel" src="${prefix}/0/panel"></iframe><script>
   const frame=document.querySelector('#panel'),chat=document.querySelector('#chat');let count=0;
   chat.onchange=()=>frame.src='${prefix}/'+chat.value+'/panel';document.querySelector('#width').onchange=e=>frame.style.width=e.target.value+'px';
   document.querySelector('#toggle').onclick=e=>{const hidden=frame.style.display==='none';frame.style.display=hidden?'block':'none';e.target.textContent=hidden?'Скрыть панель':'Показать панель';};
   addEventListener('message',async e=>{if(e.source!==frame.contentWindow||e.origin!==location.origin)return;const m=e.data;if(m.jsonrpc!=='2.0'||m.id===undefined)return;let result;
   try{if(m.method==='ui/initialize')result={protocolVersion:'2026-01-26',hostInfo:{name:'Local preview',version:'0.3.2'},hostCapabilities:{experimental:{'openai/files':{}}},hostContext:{theme:'light',displayMode:'fullscreen'}};
   else if(m.method==='tools/call'&&m.params.name==='get_context_snapshot'){const r=await fetch('${prefix}/'+chat.value+'/snapshot');if(!r.ok)throw Error('Preview HTTP '+r.status);result={structuredContent:await r.json()};document.querySelector('#requests').textContent='Запросов: '+(++count);}
   else if(m.method==='tools/call'&&m.params.name==='prepare_context_file'){const q=new URLSearchParams(m.params.arguments);const r=await fetch('${prefix}/'+chat.value+'/item?'+q);const data=await r.json();if(!r.ok)throw Error(data.error);result={structuredContent:data};}
   else if(m.method==='openai/files/open'){let n=document.querySelector('#opened-file');if(!n){n=document.createElement('p');n.id='opened-file';document.querySelector('nav').after(n);}n.textContent='Проверка команды открытия вкладки: '+m.params.path;result={};}
   else result={};e.source.postMessage({jsonrpc:'2.0',id:m.id,result},location.origin);
   }catch(err){e.source.postMessage({jsonrpc:'2.0',id:m.id,error:{message:err.message}},location.origin);}});
   </script></html>`);return;
  }
  const match=tail.match(/^(\d+)\/(panel|snapshot|item)$/);if(!match||!ids[Number(match[1])]){res.writeHead(404);res.end();return;}
  if(match[2]==='panel'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(renderHtml());return;}
  if(match[2]==='item'){res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(await files.prepare(ids[Number(match[1])],url.searchParams.get('group'),url.searchParams.get('key'))));return;}
  res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(await collector.getSnapshot(ids[Number(match[1])])));
 }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}));}
});
server.listen(0,'127.0.0.1',()=>console.log(`http://127.0.0.1:${server.address().port}${prefix}/`));
