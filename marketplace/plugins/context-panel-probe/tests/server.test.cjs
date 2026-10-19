const test=require('node:test');const assert=require('node:assert/strict');const {spawn}=require('node:child_process');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const readline=require('node:readline');
const A='01a155b5-fd0d-7643-b007-2a0f6877551c',B='01a155c1-629a-7bd3-a99c-3b2924e0e6ae';
async function client(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'context-panel-rpc-'));
 for(const [id,n] of [[A,1000],[B,2000]])fs.writeFileSync(path.join(dir,`rollout-${id}.jsonl`),[JSON.stringify({type:'session_meta',payload:{id}}),JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:n},model_context_window:4000}}}), ''].join('\n'));
 const skill=path.join(dir,'SKILL.md');fs.writeFileSync(skill,'Test skill');
 fs.appendFileSync(path.join(dir,`rollout-${A}.jsonl`),JSON.stringify({type:'world_state',payload:{full:true,state:{host_skills:{body:`- sample: Description (file: ${skill})`}}}})+'\n');
 const child=spawn(process.execPath,[path.join(__dirname,'../server.cjs')],{env:{...process.env,CONTEXT_PANEL_SESSIONS_ROOT:dir,CONTEXT_PANEL_LOG:path.join(dir,'events.jsonl')},stdio:['pipe','pipe','pipe'],windowsHide:true});
 const pending=new Map();let seq=0;
 readline.createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line);const p=pending.get(m.id);if(p){pending.delete(m.id);p(m);}});
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;const timeout=setTimeout(()=>{pending.delete(id);reject(Error('RPC timeout'))},3000);pending.set(id,m=>{clearTimeout(timeout);resolve(m)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 t.after(async()=>{child.stdin.end();child.kill();await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});
 await rpc('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'test',version:'1'}});rpc.skill=skill;return rpc;
}
test('advertises the app-only snapshot tool and keeps a thread UI entrypoint',async t=>{
 const rpc=await client(t),r=await rpc('tools/list');const snapshot=r.result.tools.find(t=>t.name==='get_context_snapshot');
 assert.ok(snapshot,'snapshot tool must exist');assert.deepEqual(snapshot._meta.ui.visibility,['app']);
 assert.deepEqual(r.result.tools.find(t=>t.name==='prepare_context_file')._meta.ui.visibility,['app']);
 assert.equal(r.result.tools.find(t=>t.name==='open_panel')._meta['openai/ui'].entrypoints[0].type,'thread');
});
test('file endpoint opens a known source and rejects cross-chat and arbitrary path requests',async t=>{
 const rpc=await client(t);const call=(id,args)=>rpc('tools/call',{name:'prepare_context_file',_meta:{threadId:id},arguments:args});
 const args={group:'skills',key:rpc.skill};const response=await call(A,args);
 assert.equal(response.result.structuredContent.path,fs.realpathSync(rpc.skill));
 assert.equal((await call(B,args)).error.message,'ITEM_NOT_FOUND');
 assert.equal((await call(A,{...args,path:'C:/secret.md'})).error.message,'INVALID_ARGUMENTS');
});
test('MCP binds to host thread IDs, ignores session-tree IDs and rejects override/conflict',async t=>{
 const rpc=await client(t);const call=(meta,args={})=>rpc('tools/call',{name:'get_context_snapshot',arguments:args,_meta:meta});
 const a=await call({threadId:A,sessionId:B});assert.equal(a.result?.structuredContent?.usedTokens,1000);
 const b=await call({thread_id:B});assert.equal(b.result?.structuredContent?.threadId,B);assert.equal(b.result?.structuredContent?.usedTokens,2000);
 assert.ok((await call({})).error);assert.ok((await call({threadId:A,thread_id:B})).error);
 assert.ok((await call({threadId:A},{threadId:B})).error);
});
