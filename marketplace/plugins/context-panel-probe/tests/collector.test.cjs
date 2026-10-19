const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {ContextCollector}=require('../lib/collector.cjs');
const A='01a155b5-fd0d-7643-b007-2a0f6877551c',B='01a155c1-629a-7bd3-a99c-3b2924e0e6ae';
function root(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'context-panel-test-'));t.after(()=>{assert.equal(path.dirname(p),os.tmpdir());fs.rmSync(p,{recursive:true,force:true});});return p;}
const meta=id=>JSON.stringify({type:'session_meta',payload:{id}})+'\n';
const usage=n=>JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{total_tokens:n},model_context_window:4000}}})+'\n';
function write(dir,id,n){const file=path.join(dir,`rollout-${id}.jsonl`);fs.writeFileSync(file,meta(id)+usage(n));return file;}
test('concurrent chat reads remain isolated and session metadata must match',async t=>{
 const dir=root(t);write(dir,A,1200);write(dir,B,2400);const c=new ContextCollector({sessionsRoot:dir});
 const [a,b,a2]=await Promise.all([c.getSnapshot(A),c.getSnapshot(B),c.getSnapshot(A)]);
 assert.equal(a.threadId,A);assert.equal(a.usedTokens,1200);assert.equal(a2.usedTokens,1200);assert.equal(b.usedTokens,2400);
 const wrong=root(t);fs.writeFileSync(path.join(wrong,`rollout-${A}.jsonl`),meta(B)+usage(99));
 await assert.rejects(new ContextCollector({sessionsRoot:wrong}).getSnapshot(A),/SESSION_MISMATCH/);
 await assert.rejects(c.getSnapshot('../escape'),/INVALID_THREAD_ID/);
});
test('partial last line is consumed exactly once after completion',async t=>{
 const dir=root(t),file=write(dir,A,1200),c=new ContextCollector({sessionsRoot:dir});await c.getSnapshot(A);
 const next=usage(1600);fs.appendFileSync(file,next.slice(0,40));assert.equal((await c.getSnapshot(A)).usedTokens,1200);
 fs.appendFileSync(file,next.slice(40));assert.equal((await c.getSnapshot(A)).usedTokens,1600);
 assert.equal((await c.getSnapshot(A)).usedTokens,1600);
});
test('bounded reads resume and preserve UTF-8 across byte boundaries',async t=>{
 const dir=root(t),file=write(dir,A,1200);fs.appendFileSync(file,JSON.stringify({type:'response_item',payload:{type:'message',id:'x',role:'user',content:[{type:'input_text',text:'Привет'.repeat(80)}]}})+'\n');
 const c=new ContextCollector({sessionsRoot:dir,chunkBytes:67});let v;
 for(let i=0;i<100;i++){v=await c.getSnapshot(A);if(v.status!=='loading')break;}
 assert.equal(v.status,'ready');assert.ok(v.usedTokens>1200);const used=v.usedTokens;assert.equal((await c.getSnapshot(A)).usedTokens,used);
});
test('truncation and same-length replacement reset cached aggregates',async t=>{
 const dir=root(t),file=write(dir,A,1200),c=new ContextCollector({sessionsRoot:dir});assert.equal((await c.getSnapshot(A)).usedTokens,1200);
 fs.writeFileSync(file,meta(A)+usage(2200));assert.equal((await c.getSnapshot(A)).usedTokens,2200);
 fs.writeFileSync(file,meta(A));const v=await c.getSnapshot(A);assert.equal(v.status,'no_usage');assert.equal(v.usedTokens,null);
});
test('missing session is explicit and a later created file can be found',async t=>{
 const dir=root(t),c=new ContextCollector({sessionsRoot:dir});assert.equal((await c.getSnapshot(A)).status,'no_session');write(dir,A,900);
 assert.equal((await c.getSnapshot(A)).usedTokens,900);
});
test('loading never exposes aggregates before matching session metadata',async t=>{
 const dir=root(t),first=usage(9876);fs.writeFileSync(path.join(dir,`rollout-${A}.jsonl`),first+meta(B));
 const c=new ContextCollector({sessionsRoot:dir,chunkBytes:Buffer.byteLength(first)});const v=await c.getSnapshot(A);
 assert.equal(v.status,'loading');assert.equal(v.usedTokens,null);assert.equal(v.details.memory.length,0);
 await assert.rejects(c.getSnapshot(A),/SESSION_MISMATCH/);
});
test('same-length in-place rewrite with unchanged suffix invalidates aggregates',async t=>{
 const dir=root(t),file=write(dir,A,1200),suffix=JSON.stringify({type:'ignored',payload:'x'.repeat(1000)})+'\n';fs.appendFileSync(file,suffix);
 const c=new ContextCollector({sessionsRoot:dir});assert.equal((await c.getSnapshot(A)).usedTokens,1200);
 fs.writeFileSync(file,meta(A)+usage(2200)+suffix);const future=new Date(Date.now()+2000);fs.utimesSync(file,future,future);
 assert.equal((await c.getSnapshot(A)).usedTokens,2200);
});
