// Throwaway feasibility probe. No session history, credentials or network access.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const ui = 'ui://context-panel-probe/panel';
const log = path.join(__dirname, '../../../probe-events.jsonl');
const tools = [
  {name:'open_panel', title:'Context binding probe', description:'Open the temporary diagnostic panel beside this chat.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false},_meta:{ui:{resourceUri:ui},'openai/ui':{entrypoints:[{type:'thread'}]}}},
  {name:'report_binding',description:'Record UI host version and conversation identity fields for the local test.',inputSchema:{type:'object',properties:{report:{type:'object'}},required:['report'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false},_meta:{ui:{visibility:['app']}}}
];
function identifiers(obj,prefix='',out={}) {
  if (!obj || typeof obj!=='object') return out;
  for (const [key,value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (/secret|token|authorization|cookie/i.test(key)) continue;
    if (/thread|conversation|session|hostId|displayMode|version|instance/i.test(key) && ['string','number'].includes(typeof value)) out[p]=value;
    else if (value && typeof value==='object') identifiers(value,p,out);
  }
  return out;
}
function record(method, params) {
  const event={at:new Date().toISOString(),method,metaKeys:Object.keys(params?._meta||{}),identity:identifiers(params?._meta),processThreadId:process.env.CODEX_THREAD_ID||null};
  if (method==='report_binding') event.report=identifiers(params.arguments?.report);
  if (method==='initialize') { event.protocolVersion=params.protocolVersion; event.clientInfo=params.clientInfo; }
  fs.appendFileSync(log,JSON.stringify(event)+'\n'); return event;
}
function handle(r) {
  switch(r.method) {
    case 'initialize': record('initialize',r.params); return {protocolVersion:r.params.protocolVersion,capabilities:{tools:{},resources:{}},serverInfo:{name:'context-panel-probe',version:'0.1.0'}};
    case 'ping': return {};
    case 'tools/list': return {tools};
    case 'resources/list': return {resources:[{uri:ui,name:'Context binding probe',mimeType:'text/html;profile=mcp-app'}]};
    case 'resources/templates/list': return {resourceTemplates:[]};
    case 'resources/read': if(r.params.uri!==ui) throw Error('Unknown resource'); record('resources/read',r.params); return {contents:[{uri:ui,mimeType:'text/html;profile=mcp-app',text:fs.readFileSync(path.join(__dirname,'panel.html'),'utf8'),_meta:{'openai/ui':{availableDisplayModes:['inline','fullscreen'],preferredDisplayMode:'fullscreen'}}}]};
    case 'tools/call': {
      if(!tools.some(t=>t.name===r.params.name)) throw Error('Unknown tool');
      const data=record(r.params.name,r.params);
      return {content:[{type:'text',text:'Local context-panel probe is ready.'}],structuredContent:data};
    }
    default: throw Error('Unknown method');
  }
}
readline.createInterface({input:process.stdin}).on('line',line=>{let r;try{r=JSON.parse(line);record('request:'+r.method,{});if(r.id===undefined)return;const result=handle(r);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n')}catch(e){record('error:'+r?.method+':'+e.message,{});process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r?.id??null,error:{code:-32603,message:e.message}})+'\n')}});
