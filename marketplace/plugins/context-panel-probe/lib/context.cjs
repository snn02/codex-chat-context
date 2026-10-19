'use strict';

const GROUPS = [
  ['messages','Сообщения','#4d79de'], ['systemTools','Встроенные инструменты','#d87546'],
  ['memory','Файлы инструкций','#58ad7e'], ['mcp','MCP-инструменты','#878985'],
  ['skills','Навыки','#92938e'], ['system','Прочий системный контекст','#a5a59d'],
  ['delta','После измерения','#b2b2aa'],
];
const finite = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const MAX_DETAILS = 300;

// Deterministic, local approximation. No claim to match the model's tokenizer.
function estimateTokens(text) {
  if (typeof text !== 'string' || !text) return 0;
  let cost = 0;
  for (const c of text) cost += /[\u0400-\u04ff]/u.test(c) ? 0.52 : c.codePointAt(0) > 0x2fff ? 1 : /[{}[\]();=<>]/.test(c) ? 0.5 : 0.25;
  return Math.ceil(cost);
}
function createState(threadId) {
  return {threadId,sessionVerified:false,model:null,effort:null,cwd:null,window:null,usage:null,
    measuredAt:null,usageSource:null,costs:{messages:0,skills:null,memory:null,systemTools:null,mcp:null},
    anchor:null,delta:0,seen:new Set(),partial:false,normalized:false,compactions:0,
    toolDescriptions:new Map(),
    details:{skills:new Map(),memory:new Map(),mcp:new Map(),systemTools:new Map(),deferredMcp:new Map(),deferredSystem:new Map()}};
}
function put(map,key,value) { if (map.has(key) || map.size < MAX_DETAILS) map.set(key,{...value,key}); }
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(x=>x&&['text','input_text','output_text'].includes(x.type)).map(x=>x.text||'').join('\n');
}
function resetHistory(s) {
  s.costs.messages=0;s.delta=0;s.seen.clear();s.partial=true;s.compactions++;
}
function updateUsage(s,info,at,source) {
  const u=info?.last_token_usage || info?.usage;
  if (!u) return;
  const total=finite(u.total_tokens)?u.total_tokens:finite(u.input_tokens)&&finite(u.output_tokens)?u.input_tokens+u.output_tokens:null;
  if (total===null) return;
  if(s.usage && total < s.usage.totalTokens) resetHistory(s);
  s.usage={totalTokens:total,inputTokens:finite(u.input_tokens)?u.input_tokens:null,outputTokens:finite(u.output_tokens)?u.output_tokens:null,cachedInputTokens:finite(u.cached_input_tokens)?u.cached_input_tokens:null};
  if(finite(info.model_context_window)&&info.model_context_window>0)s.window=info.model_context_window;
  s.anchor={...s.costs};s.delta=0;s.measuredAt=at||null;s.usageSource=source;
}
function world(s,p) {
  const state=p.state||{};
  const owns=key=>p.full||Object.hasOwn(state,key);
  if(owns('host_skills')) {
    s.details.skills.clear();s.costs.skills=null;
    if(s.anchor)s.anchor.skills=null;
  }
  if(owns('agents_md')) {
    s.details.memory.clear();
    s.costs.memory=null;if(s.anchor)s.anchor.memory=null;
  }
  if (owns('tools')) {
    s.details.deferredMcp.clear();s.details.deferredSystem.clear();s.toolDescriptions.clear();
    for(const [name,description] of Object.entries(state.tools||{})) {
      if(typeof description!=='string')continue;
      const group=name.startsWith('mcp__')?s.details.deferredMcp:s.details.deferredSystem;
      put(group,name,{name,tokens:estimateTokens(name+' '+description),status:'catalog',kind:'namespace'});
      if(group.has(name))s.toolDescriptions.set(name,description.slice(0,64000));
    }
  }
  if (p.state?.host_skills) {
    const body=p.state.host_skills.body;
    if(typeof body==='string') {
      s.costs.skills=estimateTokens(body);s.details.skills.clear();
      if(s.anchor)s.anchor.skills=s.costs.skills;
      const roots=new Map();
      for(const line of body.split('\n')) {
        const root=line.match(/^\s*-\s*`(r\d+)`\s*=\s*`([^`]+)`\s*$/);
        if(root)roots.set(root[1],root[2]);
      }
      for(const line of body.split('\n')) {
        const m=line.match(/^\s*-\s+(.+?):\s+.*?\(file:\s*(.+?)\)\s*$/);
        if(m) {
          const alias=m[2].match(/^(r\d+)[\\/](.+)$/);
          const file=alias&&roots.has(alias[1])?roots.get(alias[1]).replace(/[\\/]$/,'')+'/'+alias[2]:m[2];
          put(s.details.skills,m[2],{name:m[1],path:file,tokens:estimateTokens(line),status:'catalog'});
        }
      }
    }
  }
  const instructions=p.state?.agents_md;
  if(instructions && typeof instructions==='object') {
    // Count only explicit text bodies. Never assume every file in a workspace is loaded.
    const entries=Object.entries(instructions).filter(([,v])=>typeof v==='string'||typeof v?.content==='string'||typeof v?.body==='string');
    {
      s.costs.memory=0;
      for(const [name,value] of entries) {
        const text=typeof value==='string'?value:value.content||value.body;
        const tokens=estimateTokens(text);s.costs.memory+=tokens;
        put(s.details.memory,name,{name:name.split(/[\\/]/).pop(),path:name,tokens,status:'snapshot'});
      }
      if(s.anchor)s.anchor.memory=s.costs.memory;
    }
  }
}
function consume(s,event) {
  if(!event || typeof event!=='object')return;
  const p=event.payload||{};
  if(event.type==='session_meta') {
    if(p.id!==s.threadId)throw new Error('SESSION_MISMATCH');
    s.sessionVerified=true;s.cwd=typeof p.cwd==='string'?p.cwd:null;
    return;
  }
  if(event.type==='turn_context') {
    if(typeof p.model==='string')s.model=p.model;
    if(typeof p.effort==='string')s.effort=p.effort;
    return;
  }
  if(event.type==='world_state'){world(s,p);return;}
  if(event.type==='compacted') {
    resetHistory(s);s.usage=null;s.anchor=null;s.measuredAt=null;
    if(Array.isArray(p.replacement_history))for(const item of p.replacement_history)consume(s,{type:'response_item',payload:item});
    return;
  }
  if(event.type==='event_msg'&&p.type==='token_count'){updateUsage(s,p.info,event.timestamp,'token_count');return;}
  if(event.type==='token_usage_record'&&s.usageSource!=='token_count'){updateUsage(s,p,event.timestamp,'token_usage_record');return;}
  if(event.type!=='response_item')return;
  // Reasoning and service messages are intentionally never surfaced or inspected.
  let text='';
  if(p.type==='message'&&['user','assistant'].includes(p.role))text=textOf(p.content);
  else if(['function_call','custom_tool_call'].includes(p.type)) {
    text=typeof p.input==='string'?p.input:typeof p.arguments==='string'?p.arguments:'';
    const name=[p.namespace,p.name].filter(Boolean).join('.');
    if(name)put(name.includes('mcp__')?s.details.mcp:s.details.systemTools,name,{name,tokens:null,status:'observed'});
  } else if(['function_call_output','custom_tool_call_output'].includes(p.type))text=textOf(p.output);
  else return;
  const id=p.id||p.call_id&&p.type+':'+p.call_id;
  if(id && s.seen.has(id))return;
  if(id) {if(s.seen.size>=50000){s.partial=true;return;}s.seen.add(id);}
  const tokens=estimateTokens(text);
  s.costs.messages+=tokens;
  if(s.usage)s.delta+=tokens;
}
function snapshot(s,{now=Date.now()}={}) {
  const base=s.usage?.totalTokens??null;
  const raw=s.anchor||s.costs;
  const sum=['messages','systemTools','memory','mcp','skills'].reduce((n,k)=>n+(raw[k]||0),0);
  const scale=base!==null && sum>base && sum>0?base/sum:1;
  let allocated=0;
  const categories=GROUPS.map(([id,label,color])=>{
    let tokens=null;
    if(id==='delta')tokens=base===null?null:s.delta;
    else if(id==='system')tokens=base===null?null:Math.max(0,base-allocated);
    else if(raw[id]!==null&&raw[id]!==undefined){tokens=Math.floor(raw[id]*scale);allocated+=tokens;}
    return {id,label,color,tokens,percent:s.window&&tokens!==null?tokens/s.window*100:null,estimated:true};
  });
  const used=base===null?null:base+s.delta;
  const window=s.window;
  const free=used!==null&&window?Math.max(0,window-used):null;
  return {schemaVersion:1,threadId:s.threadId,status:base===null?'no_usage':'ready',
    model:s.model,effort:s.effort,cwd:s.cwd,source:'Локальный журнал Codex',
    updatedAt:new Date(now).toISOString(),measuredAt:s.measuredAt,
    usedTokens:used,windowTokens:window,usedPercent:used!==null&&window?used/window*100:null,
    freeTokens:free,
    overflowTokens:used!==null&&window?Math.max(0,used-window):0,
    normalized:scale<1,partial:s.partial,compactions:s.compactions,categories,
    usage:s.usage,details:Object.fromEntries(Object.entries(s.details).map(([k,v])=>[k,Array.from(v.values())])),
    notices:[...(scale<1?['Разбивка нормирована к последнему измерению.']:[]),...(s.partial?['После сжатия или неполной истории часть контекста отнесена к системному остатку.']:[]),
      'Размеры категорий оценочные. Системный остаток включает неразобранные служебные данные.',
      'Отложенный каталог не равен полным схемам инструментов и не прибавляется к полосе.']};
}
module.exports={createState,consume,snapshot,estimateTokens};
