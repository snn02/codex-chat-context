(function(){
'use strict';
function createPoller({request,onData,onError,isVisible=()=>true,setTimer=setTimeout,clearTimer=clearTimeout,interval=5000}) {
  let running=false,timer=null,busy=null,generation=0;
  function cancel(){if(timer!==null){clearTimer(timer);timer=null;}}
  function schedule(){cancel();if(running&&isVisible())timer=setTimer(()=>{timer=null;refresh();},interval);}
  function refresh(){
    cancel();if(!running||!isVisible())return Promise.resolve();if(busy)return busy;
    const version=generation;
    // Call synchronously so visibility/manual refresh cannot enqueue another request.
    let result;try{result=request();}catch(e){result=Promise.reject(e);}
    busy=Promise.resolve(result).then(data=>{if(running&&version===generation)onData(data);}).catch(error=>{if(running&&version===generation)onError(error);}).finally(()=>{busy=null;schedule();});
    return busy;
  }
  return {start(){running=true;refresh();},refresh,visibilityChanged(){cancel();if(isVisible())refresh();},stop(){running=false;generation++;cancel();}};
}
function createRpcBridge({send,timeoutMs=12000,setTimer=setTimeout,clearTimer=clearTimeout}) {
  let counter=0;const pending=new Map();
  return {
    request(method,params){return new Promise((resolve,reject)=>{
      const id=++counter,timer=setTimer(()=>{pending.delete(id);reject(Error('Codex не ответил на запрос. Попробуйте обновить панель.'));},timeoutMs);
      pending.set(id,{resolve,reject,timer});
      try{send({jsonrpc:'2.0',id,method,params});}catch(e){pending.delete(id);clearTimer(timer);reject(e);}
    });},
    receive(m){if(!m||m.jsonrpc!=='2.0'||!pending.has(m.id))return false;const p=pending.get(m.id);pending.delete(m.id);clearTimer(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);return true;},
    dispose(){for(const p of pending.values()){clearTimer(p.timer);p.reject(Error('Панель закрыта'));}pending.clear();},
  };
}
function createFileOpener({request,canOpen,getThreadId}) {
  const pending=new Map();
  return async function open(group,key) {
    if(!canOpen())throw Error('Эта версия приложения не поддерживает открытие файла во вкладке из панели.');
    const threadId=getThreadId(),token=threadId+'\0'+group+'\0'+key;
    if(pending.has(token))return pending.get(token);
    const job=(async()=>{
      let r;
      try{r=await request('tools/call',{name:'prepare_context_file',arguments:{group,key}});}catch(e){
        const messages={UNKNOWN_TOOL:'Перезапустите Codex, чтобы подключить новую команду открытия файлов.',ITEM_NOT_FOUND:'Элемент больше не найден в текущем чате. Обновите панель.',FILE_NOT_FOUND:'Файл не найден на диске. Возможно, файл перемещён или удалён.',FILE_PATH_UNAVAILABLE:'Для этой записи нет доступного абсолютного пути к файлу.',NOT_A_FILE:'По этому пути находится не файл.'};
        throw Error(messages[e.message]||e.message);
      }
      if(r?.isError)throw Error(r.content?.find(x=>x.type==='text')?.text||'Не удалось подготовить файл.');
      const file=r?.structuredContent;
      if(file?.threadId!==threadId||getThreadId()!==threadId)throw Error('Получен файл другого чата. Откройте панель заново.');
      if(typeof file.path!=='string'||!file.path)throw Error('Путь к файлу недоступен.');
      await request('openai/files/open',{path:file.path});
      return file;
    })();
    pending.set(token,job);try{return await job;}finally{pending.delete(token);}
  };
}
if(typeof module!=='undefined'&&module.exports)module.exports={createPoller,createRpcBridge,createFileOpener};
if(typeof window==='undefined'||typeof document==='undefined')return;

const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const compact=n=>n===null||n===undefined?'—':n>=1e6?(n/1e6).toLocaleString('ru-RU',{maximumFractionDigits:1})+'M':n>=1000?(n/1000).toLocaleString('ru-RU',{maximumFractionDigits:1})+'k':Math.round(n).toLocaleString('ru-RU');
const pct=n=>n===null||n===undefined?'—':n.toLocaleString('ru-RU',{maximumFractionDigits:1})+'%';
const statusLabels={catalog:'Каталог: оценка описания, не полного содержимого',observed:'Вызов встречался в истории; размер схемы неизвестен',snapshot:'Инструкции присутствуют в снимке'};
const descriptions={messages:'Оценка текста сообщений, вызовов и результатов инструментов в доступной истории.',systemTools:'Размер загруженных схем. Прочерк означает, что схемы недоступны; их вклад может находиться в системном остатке.',memory:'Файлы из явного снимка инструкций Codex. Упоминания в сообщениях и примерах сюда не включаются.',mcp:'Размер загруженных MCP-схем, если они известны.',skills:'Каталог навыков. Это не сумма всех файлов SKILL.md.',system:'Разница между измерением Codex и оценкой известных частей. Не точный размер системного промпта.',delta:'Оценка новых записей после последнего счётчика токенов.'};
let current=null,expectedThread=null,lastUpdated='',intersecting=true,initialized=false,filesAvailable=false;
const sections=new Map();
for(const [key,title] of [['mcp','MCP-инструменты'],['systemTools','Встроенные инструменты'],['memory','Файлы инструкций'],['skills','Навыки']]) {
  const d=el('details');d.id='section-'+key;const summary=el('summary');summary.append(el('span','',title));const count=el('span','count','—');summary.append(count);const body=el('div','detail-list');d.append(summary,body);$('sections').append(d);sections.set(key,{d,count,body});
}
function showError(error){$('status').textContent=(current?'Данные сохранены, но обновление не удалось. ':'')+error.message;$('status').className='status error';}
function row(label,tokens,percent,color,key,title) {
  const r=el('div','row');const swatch=el('span','swatch');swatch.style.background=color;
  const link=key&&sections.has(key);const name=el(link?'button':'span','label'+(link?' link':''),label);name.title=title||'Оценочное значение';
  if(link)name.onclick=()=>{const d=sections.get(key).d;d.open=true;d.scrollIntoView({block:'nearest',behavior:'auto'});};
  r.append(swatch,name,el('span','tokens',compact(tokens)),el('span','percent',pct(percent)));return r;
}
function render(v) {
  if(!v||v.schemaVersion!==1||!Array.isArray(v.categories))return;
  if(expectedThread&&v.threadId!==expectedThread){showError(Error('Получена другая привязка чата. Откройте панель заново в нужном чате.'));return;}
  if(lastUpdated&&v.updatedAt<lastUpdated)return;
  expectedThread=v.threadId;lastUpdated=v.updatedAt;current=v;
  $('model').textContent=v.model||'';$('model').title=[v.model,v.effort].filter(Boolean).join(' · ');
  $('usage').textContent=v.usedPercent===null?'Нет измерения':'≈'+Math.round(v.usedPercent)+'% занято';
  $('capacity').textContent=(v.usedTokens===null?'—':'≈'+compact(v.usedTokens))+' / '+compact(v.windowTokens);
  $('legend').replaceChildren(...v.categories.map(c=>row(c.label,c.tokens,c.percent,c.color,c.id,descriptions[c.id])));
  $('legend').append(row('Свободное место',v.freeTokens,v.windowTokens&&v.freeTokens!==null?v.freeTokens/v.windowTokens*100:null,'var(--track)',null,'Остаток после занятого места.'));
  const bar=$('bar');bar.replaceChildren();
  for(const part of [...v.categories,{label:'Свободное место',tokens:v.freeTokens,color:'var(--track)'}]) {
    if(!part.tokens||!v.windowTokens)continue;const seg=el('span','segment');seg.style.flexGrow=String(part.tokens);seg.style.background=part.color;seg.title=part.label+': ≈'+compact(part.tokens);bar.append(seg);
  }
  bar.setAttribute('aria-label',v.usedPercent===null?'Заполненность неизвестна':'Оценочно занято '+pct(v.usedPercent));
  const total=items=>items?.length?items.reduce((n,x)=>n+(x.tokens||0),0):null;
  $('deferred').replaceChildren(row('MCP (отложенные)',total(v.details.deferredMcp),null,'var(--deferred)',null,'Оценка краткого каталога пространств имён; не полных схем. Не прибавляется к полосе.'),row('Встроенные (отложенные)',total(v.details.deferredSystem),null,'var(--deferred)',null,'Отдельный каталог, если он доступен. Не прибавляется к полосе.'));
  for(const [key,section] of sections) {
    const groups=key==='mcp'?['mcp','deferredMcp']:key==='systemTools'?['systemTools','deferredSystem']:[key];
    const list=groups.flatMap(group=>v.details[group].map(item=>({...item,group})));
    section.count.textContent=String(list.length);section.count.title='Количество известных записей; каталог может содержать пространства имён, а не отдельные инструменты.';
    const scroll=section.body.scrollTop;
    section.body.replaceChildren(...list.map(item=>{
      const r=el('div','detail-row');const name=el('button','detail-name detail-open',item.path||item.name);
      name.type='button';name.title=(item.path||item.name)+'\n'+(statusLabels[item.status]||'Оценка')+'\nОткрыть '+(item.path?'файл':'описание')+' во вкладке Codex';
      name.onclick=async()=>{name.disabled=true;$('file-status').textContent='Открываем…';$('file-status').className='status';try{await openFile(item.group,item.key||item.path||item.name);$('file-status').textContent='';}catch(e){$('file-status').textContent=e.message;$('file-status').className='status error';}finally{name.disabled=false;}};
      r.append(name,el('span','tokens',compact(item.tokens)));return r;
    }));
    if(!list.length)section.body.append(el('p','empty','Нет подтверждённых записей в доступном журнале.'));
    section.body.scrollTop=scroll;
  }
  $('status').className='status';
  $('status').textContent=v.status==='no_session'?'Журнал этого чата пока не найден.':v.status==='no_usage'?'Ожидаем первое измерение токенов Codex.':v.status==='loading'?'Читаем журнал… '+Math.round((v.readProgress||0)*100)+'%':v.overflowTokens?'Оценка превышает окно на '+compact(v.overflowTokens)+' токенов.':'';
  $('badge').textContent=v.partial?'≈ Неполная разбивка':v.normalized?'≈ Разбивка приведена к измерению Codex':'';
  $('freshness').textContent='≈ Обновлено '+new Date(v.updatedAt).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const diag=[...v.notices,'Источник: '+v.source,'Счётчик: '+(v.measuredAt?new Date(v.measuredAt).toLocaleString('ru-RU'):'недоступен'),'Чат: '+v.threadId,'Папка: '+(v.cwd||'неизвестна'),'Вход: '+compact(v.usage?.inputTokens)+' · ответ: '+compact(v.usage?.outputTokens)+' · кеш входа: '+compact(v.usage?.cachedInputTokens),'Сжатий в доступном журнале: '+v.compactions];
  $('diagnostic-body').replaceChildren(...diag.map(t=>el('p','',t)));
}
function theme(context){if(context&&['light','dark'].includes(context.theme))document.documentElement.dataset.theme=context.theme;}
const rpc=createRpcBridge({send:m=>parent.postMessage(m,'*')});
const openFile=createFileOpener({request:(method,params)=>rpc.request(method,params),canOpen:()=>filesAvailable,getThreadId:()=>expectedThread});
const poller=createPoller({
  isVisible:()=>initialized&&!document.hidden&&intersecting,
  request:async()=>{$('refresh').disabled=true;try{const r=await rpc.request('tools/call',{name:'get_context_snapshot',arguments:{}});if(r?.isError)throw Error(r.content?.find(x=>x.type==='text')?.text||'Ошибка чтения');if(r?.structuredContent?.schemaVersion!==1)throw Error('Сервер ещё использует старую версию. Перезагрузите плагин.');return r.structuredContent;}finally{$('refresh').disabled=false;}},
  onData:render,onError:showError,
});
window.addEventListener('message',e=>{
  if(e.source!==parent)return;const m=e.data;if(!m||m.jsonrpc!=='2.0')return;
  if(rpc.receive(m))return;
  if(m.method==='ui/notifications/tool-result')render(m.params?.structuredContent);
  if(m.method==='ui/notifications/host-context-changed')theme(m.params);
});
$('refresh').onclick=()=>poller.refresh();
document.addEventListener('visibilitychange',()=>poller.visibilityChanged());
if(typeof IntersectionObserver!=='undefined')new IntersectionObserver(entries=>{intersecting=entries[0]?.isIntersecting!==false;poller.visibilityChanged();}).observe(document.documentElement);
window.addEventListener('pagehide',()=>poller.stop());window.addEventListener('pageshow',()=>{if(initialized)poller.start();});
rpc.request('ui/initialize',{appInfo:{name:'Контекст чата',version:'0.3.2'},appCapabilities:{availableDisplayModes:['inline','fullscreen']},protocolVersion:'2026-01-26'}).then(host=>{
  filesAvailable=Object.hasOwn(host?.hostCapabilities?.experimental||{},'openai/files');
  theme(host?.hostContext);parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/initialized'},'*');initialized=true;
  rpc.request('tools/call',{name:'report_binding',arguments:{report:{instance:crypto.randomUUID()}}}).catch(()=>{});
  poller.start();
}).catch(showError);
})();
