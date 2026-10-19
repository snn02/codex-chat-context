'use strict';
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline');
const {ContextCollector}=require('./lib/collector.cjs');
const {ContextFiles}=require('./lib/files.cjs');
const VERSION='0.3.2';
const URI='ui://context-panel-probe/panel';
const log=process.env.CONTEXT_PANEL_LOG||path.join(__dirname,'../../../probe-events.jsonl');
const collector=new ContextCollector(process.env.CONTEXT_PANEL_SESSIONS_ROOT?{sessionsRoot:process.env.CONTEXT_PANEL_SESSIONS_ROOT}:{});
const contextFiles=new ContextFiles({collector});
const empty={type:'object',properties:{},additionalProperties:false};
const annotations={readOnlyHint:true,destructiveHint:false,openWorldHint:false};
const tools=[
  {name:'open_panel',title:'Контекст чата',description:'Open the context usage panel beside this chat: local token counts, estimated categories, tools and instructions.',inputSchema:empty,annotations,_meta:{ui:{resourceUri:URI},'openai/ui':{entrypoints:[{type:'thread'}]}}},
  {name:'get_context_snapshot',description:'Read the context estimate for the host-bound chat. Does not run a model or modify the conversation.',inputSchema:empty,annotations,_meta:{ui:{visibility:['app']}}},
  {name:'prepare_context_file',description:'Resolve an existing instruction or skill file, or prepare a local tool description card, for a selected item of the host-bound chat.',inputSchema:{type:'object',properties:{group:{type:'string',enum:['skills','memory','mcp','systemTools','deferredMcp','deferredSystem']},key:{type:'string',minLength:1,maxLength:4096}},required:['group','key'],additionalProperties:false},annotations:{...annotations,readOnlyHint:false},_meta:{ui:{visibility:['app']}}},
  {name:'report_binding',description:'Record local panel initialization and host-provided binding.',inputSchema:{type:'object',properties:{report:{type:'object'}},required:['report'],additionalProperties:false},annotations:{...annotations,readOnlyHint:false},_meta:{ui:{visibility:['app']}}},
];
function resolveThreadId(meta={}) {
  let nested=meta['x-codex-turn-metadata'];
  if(typeof nested==='string'){try{nested=JSON.parse(nested);}catch{throw Error('INVALID_THREAD_METADATA');}}
  const values=[meta.threadId,meta.thread_id,nested?.thread_id,nested?.threadId].filter(x=>x!==undefined&&x!==null);
  if(!values.length)throw Error('THREAD_BINDING_MISSING');
  if(values.some(v=>typeof v!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)))throw Error('INVALID_THREAD_ID');
  if(new Set(values.map(v=>v.toLowerCase())).size!==1)throw Error('THREAD_BINDING_CONFLICT');
  return values[0].toLowerCase();
}
function record(method,threadId,extra={}) {
  try {fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),method,version:VERSION,identity:threadId?{threadId}:{},...extra})+'\n');}
  catch { /* Diagnostics must not prevent read-only operation. */ }
}
function renderHtml() {
  const html=fs.readFileSync(path.join(__dirname,'panel.html'),'utf8');
  return html.includes('<!--PANEL_SCRIPT-->')?html.replace('<!--PANEL_SCRIPT-->',()=>'<script>'+fs.readFileSync(path.join(__dirname,'panel.js'),'utf8').replace(/<\/script/gi,'<\\/script')+'</script>'):html;
}
async function handle(r) {
  const p=r.params||{};
  switch(r.method) {
    case 'initialize':return {protocolVersion:p.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:'context-panel-probe',version:VERSION}};
    case 'ping':return {};
    case 'tools/list':return {tools};
    case 'resources/list':return {resources:[{uri:URI,name:'Контекст чата',mimeType:'text/html;profile=mcp-app'}]};
    case 'resources/templates/list':return {resourceTemplates:[]};
    case 'resources/read':
      if(p.uri!==URI)throw Error('UNKNOWN_RESOURCE');
      return {contents:[{uri:URI,mimeType:'text/html;profile=mcp-app',text:renderHtml(),_meta:{'openai/ui':{availableDisplayModes:['inline','fullscreen'],preferredDisplayMode:'fullscreen'}}}]};
    case 'tools/call': {
      if(!tools.some(t=>t.name===p.name))throw Error('UNKNOWN_TOOL');
      const id=resolveThreadId(p._meta),args=p.arguments||{};
      const allowed=p.name==='report_binding'?['report']:p.name==='prepare_context_file'?['group','key']:[];
      if(!args||Array.isArray(args)||typeof args!=='object'||Object.keys(args).some(k=>!allowed.includes(k)))throw Error('INVALID_ARGUMENTS');
      if(p.name==='report_binding') {
        record('report_binding',id,{report:{instance:typeof args.report?.instance==='string'?args.report.instance.slice(0,100):null}});
        return {content:[{type:'text',text:'Panel binding recorded.'}],structuredContent:{threadId:id,version:VERSION}};
      }
      if(p.name==='prepare_context_file') {
        const file=await contextFiles.prepare(id,args.group,args.key);
        return {content:[{type:'text',text:'File ready to open.'}],structuredContent:file};
      }
      const data=await collector.getSnapshot(id);
      if(p.name==='open_panel')record('open_panel',id,{usedTokens:data.usedTokens,windowTokens:data.windowTokens});
      return {content:[{type:'text',text:data.usedTokens===null?'Context statistics are not available yet.':`Context estimate: ${Math.round(data.usedTokens)} tokens${data.usedPercent===null?'':`, ${data.usedPercent.toFixed(1)}% of the reported window`}.`}],structuredContent:data};
    }
    default:throw Error('UNKNOWN_METHOD');
  }
}
if(require.main===module) {
  readline.createInterface({input:process.stdin}).on('line',async line=>{
    let r;
    try {r=JSON.parse(line);if(r.id===undefined)return;const result=await handle(r);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n');}
    catch(e){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r?.id??null,error:{code:-32602,message:e.message}})+'\n');}
  });
}
module.exports={handle,resolveThreadId,renderHtml,VERSION};
