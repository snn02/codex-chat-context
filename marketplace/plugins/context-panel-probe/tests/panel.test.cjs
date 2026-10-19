const test=require('node:test');const assert=require('node:assert/strict');
const {createPoller,createRpcBridge,createFileOpener}=require('../panel.js');
const tick=()=>new Promise(r=>setImmediate(r));
test('polling pauses while hidden, resumes immediately and never overlaps a slow request',async()=>{
 let visible=false,requests=0,resolve;const timers=new Map();let tid=0;const values=[];
 const p=createPoller({request:()=>{requests++;return new Promise(r=>resolve=r)},onData:x=>values.push(x),onError:()=>{},isVisible:()=>visible,setTimer:(f,ms)=>{timers.set(++tid,{f,ms});return tid},clearTimer:id=>timers.delete(id)});
 p.start();assert.equal(requests,0);visible=true;p.visibilityChanged();assert.equal(requests,1);
 p.refresh();p.refresh();assert.equal(requests,1);visible=false;p.visibilityChanged();resolve({version:1});await tick();assert.equal(timers.size,0);
 visible=true;p.visibilityChanged();assert.equal(requests,2);resolve({version:2});await tick();assert.equal(values.at(-1).version,2);
 assert.equal([...timers.values()][0].ms,5000);p.stop();assert.equal(timers.size,0);
});
test('stopped polls cannot render delayed responses and a failure permits retry',async()=>{
 let resolve;const values=[],errors=[];const p=createPoller({request:()=>new Promise(r=>resolve=r),onData:v=>values.push(v),onError:e=>errors.push(e),isVisible:()=>true});
 p.start();p.stop();resolve({stale:true});await tick();assert.equal(values.length,0);
 let fail=true;const q=createPoller({request:async()=>{if(fail)throw Error('offline');return {ok:true}},onData:v=>values.push(v),onError:e=>errors.push(e),isVisible:()=>true});
 q.start();await tick();assert.equal(errors.length,1);fail=false;await q.refresh();assert.equal(values.at(-1).ok,true);q.stop();
});
test('bridge correlates replies and releases a timed-out request',async()=>{
 const sent=[];const rpc=createRpcBridge({send:m=>sent.push(m),timeoutMs:15});
 const first=rpc.request('tools/call',{name:'get_context_snapshot',arguments:{}});
 assert.deepEqual(sent[0].params,{name:'get_context_snapshot',arguments:{}});
 rpc.receive({jsonrpc:'2.0',id:sent[0].id,result:{structuredContent:{usedTokens:123}}});assert.equal((await first).structuredContent.usedTokens,123);
 await assert.rejects(rpc.request('tools/call',{}),/ответ/);
 const third=rpc.request('ping',{});rpc.receive({jsonrpc:'2.0',id:sent.at(-1).id,result:{ok:true}});assert.equal((await third).ok,true);rpc.dispose();
});
test('item click prepares the selected item and opens a native Codex file tab',async()=>{
 const calls=[];const open=createFileOpener({canOpen:()=>true,getThreadId:()=>'chat-a',request:async(method,params)=>{calls.push({method,params});return method==='tools/call'?{structuredContent:{threadId:'chat-a',path:'C:/skills/SKILL.md'}}:{};}});
 await open('skills','r1/SKILL.md');
 assert.deepEqual(calls,[{method:'tools/call',params:{name:'prepare_context_file',arguments:{group:'skills',key:'r1/SKILL.md'}}},{method:'openai/files/open',params:{path:'C:/skills/SKILL.md'}}]);
});
test('file opening rejects unsupported hosts and mismatched chat results',async()=>{
 let requests=0;const unsupported=createFileOpener({canOpen:()=>false,getThreadId:()=>'a',request:async()=>{requests++}});
 await assert.rejects(unsupported('skills','x'),/вкладк/);assert.equal(requests,0);
 const mismatch=createFileOpener({canOpen:()=>true,getThreadId:()=>'a',request:async()=>{requests++;return {structuredContent:{threadId:'b',path:'C:/other.md'}}}});
 await assert.rejects(mismatch('skills','x'),/другого чата/);assert.equal(requests,1);
});
