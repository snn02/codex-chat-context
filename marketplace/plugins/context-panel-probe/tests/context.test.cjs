const test = require('node:test');
const assert = require('node:assert/strict');
const { createState, consume, snapshot, estimateTokens } = require('../lib/context.cjs');
const A = '01a155b5-fd0d-7643-b007-2a0f6877551c';
const event = (type, payload) => ({ type, timestamp: '2026-10-19T20:00:00Z', payload });
const usage = (last = 1200, window = 4000) => event('event_msg', {type:'token_count',info:{last_token_usage:{input_tokens:last-200,output_tokens:200,total_tokens:last},total_token_usage:{total_tokens:900000},model_context_window:window}});
const message = (text, id='m1') => event('response_item',{type:'message',id,role:'user',content:[{type:'input_text',text}]});

test('uses last request, not cumulative spend, and accounts for the complete budget', () => {
  const s = createState(A); consume(s,message('Hello world')); consume(s,usage());
  const v = snapshot(s);
  assert.equal(v.threadId,A); assert.equal(v.usedTokens,1200); assert.equal(v.windowTokens,4000);
  assert.equal(v.usedPercent,30); assert.equal(v.freeTokens,2800);
  assert.equal(v.categories.reduce((n,c)=>n+(c.tokens||0),0),1200);
});
test('unknown usage/window remains unavailable rather than zero or a guessed limit', () => {
  const s=createState(A);consume(s,message('hello'));
  assert.equal(snapshot(s).usedTokens,null); assert.equal(snapshot(s).freeTokens,null);
  consume(s,usage(1200,null));assert.equal(snapshot(s).usedPercent,null);
});
test('Unicode estimates distinguish Cyrillic from ASCII and handle empty text', () => {
  assert.equal(estimateTokens(''),0); assert.ok(estimateTokens('привет мир')>estimateTokens('hello you!'));
  assert.ok(Number.isFinite(estimateTokens('😀漢字 const a = 1;')));
});
test('normalizes an oversized breakdown without negative remainder', () => {
  const s=createState(A);consume(s,message('a'.repeat(20000)));consume(s,usage());const v=snapshot(s);
  assert.equal(v.categories.reduce((n,c)=>n+(c.tokens||0),0),1200);
  assert.ok(v.categories.every(c=>c.tokens===null||c.tokens>=0));assert.equal(v.normalized,true);
});
test('deduplicates response ids and adds only new records after the measurement', () => {
  const s=createState(A);consume(s,message('a'.repeat(400)));consume(s,usage());
  consume(s,message('b'.repeat(400),'m2'));const once=snapshot(s);consume(s,message('b'.repeat(400),'m2'));
  assert.ok(once.usedTokens>1200);assert.equal(snapshot(s).usedTokens,once.usedTokens);
  assert.equal(snapshot(s).categories.find(c=>c.id==='delta').tokens,once.usedTokens-1200);
});
test('compaction invalidates stale totals until a fresh measurement and removes old messages', () => {
  const s=createState(A);consume(s,message('x'.repeat(20000)));consume(s,usage(3000));
  consume(s,event('compacted',{message:'private summary'}));assert.equal(snapshot(s).usedTokens,null);
  consume(s,usage(500));const v=snapshot(s);assert.equal(v.usedTokens,500);assert.equal(v.partial,true);
  assert.equal(v.categories.find(c=>c.id==='messages').tokens,0);
});
test('a falling token counter invalidates historic attribution even without a compaction event', () => {
  const s=createState(A);consume(s,message('x'.repeat(5000)));consume(s,usage(3000));consume(s,usage(500));
  const v=snapshot(s);assert.equal(v.partial,true);assert.equal(v.categories.find(c=>c.id==='messages').tokens,0);
});
test('snapshots expose aggregates, never message text, reasoning or service instructions', () => {
  const s=createState(A);consume(s,message('USER_SECRET_123'));
  consume(s,event('response_item',{type:'reasoning',content:[{text:'REASONING_SECRET'}]}));
  consume(s,event('session_meta',{id:A,base_instructions:{text:'SYSTEM_SECRET'}}));consume(s,usage());
  const json=JSON.stringify(snapshot(s));assert.doesNotMatch(json,/USER_SECRET|REASONING_SECRET|SYSTEM_SECRET/);
});
test('catalog tools are deferred and skill catalog entries are not full skill loads', () => {
  const s=createState(A);consume(s,event('world_state',{full:true,state:{tools:{mcp__drive:'Search documents'},host_skills:{body:'- example: Summary (file: C:/skills/example/SKILL.md)'}}}));consume(s,usage());
  const v=snapshot(s);assert.equal(v.details.deferredMcp[0].name,'mcp__drive');
  assert.equal(v.details.skills[0].status,'catalog');assert.equal(v.categories.find(c=>c.id==='mcp').tokens,null);
  assert.equal(v.usedTokens,1200);
});
test('overflow is explicit and free space never goes negative', () => {
  const s=createState(A);consume(s,usage(5000,4000));const v=snapshot(s);
  assert.equal(v.freeTokens,0);assert.equal(v.overflowTokens,1000);assert.equal(v.usedPercent,125);
});

test('paths in messages and tool code or output are not loaded instruction files',()=>{
 const s=createState(A);consume(s,message('Discuss profit/loss for CONFIDENTIAL_CLIENT before checking AGENTS.md. Read C:/project/AGENTS.md and /home/me/MEMORY.md.'));
 consume(s,event('response_item',{type:'function_call',name:'exec_command',arguments:JSON.stringify({cmd:"const fixture = {'C:/AGENTS.md':'Instructions'}"})}));
 consume(s,event('response_item',{type:'function_call_output',output:'C:/project/AGENTS.md /home/me/MEMORY.md C:/AGENTS.md'}));
 const v=snapshot(s);assert.doesNotMatch(JSON.stringify(v),/CONFIDENTIAL_CLIENT/);
 assert.deepEqual(v.details.memory,[]);
});

test('mentioning a confirmed instruction path preserves its source and token estimate',()=>{
 const s=createState(A);
 consume(s,event('world_state',{state:{agents_md:{'C:/project/AGENTS.md':'Project instructions'}}}));
 const confirmed=snapshot(s).details.memory;
 assert.equal(confirmed.length,1);assert.equal(confirmed[0].status,'snapshot');assert.ok(confirmed[0].tokens>0);
 consume(s,message('Read C:/project/AGENTS.md'));
 assert.deepEqual(snapshot(s).details.memory,confirmed);
});
test('full worlds and explicit empty instruction maps replace derived catalogs',()=>{
 const s=createState(A);const filled={tools:{mcp__drive:'Search'},host_skills:{body:'- example: Summary (file: C:/skills/example/SKILL.md)'},agents_md:{'C:/AGENTS.md':'Instructions'}};
 consume(s,event('world_state',{full:true,state:filled}));consume(s,event('world_state',{state:{agents_md:{}}}));
 assert.equal(snapshot(s).details.memory.length,0);assert.equal(s.costs.memory,0);
 consume(s,event('world_state',{full:true,state:filled}));consume(s,usage());
 consume(s,event('world_state',{full:true,state:{}}));
 const v=snapshot(s);assert.equal(v.details.skills.length,0);assert.equal(v.details.deferredMcp.length,0);assert.equal(v.details.memory.length,0);
 assert.equal(v.categories.find(x=>x.id==='skills').tokens,null);assert.equal(v.categories.find(x=>x.id==='memory').tokens,null);
});
