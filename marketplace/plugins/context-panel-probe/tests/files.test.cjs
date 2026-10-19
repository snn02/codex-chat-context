const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {ContextCollector}=require('../lib/collector.cjs');
const {ContextFiles}=require('../lib/files.cjs');
const A='01a155b5-fd0d-7643-b007-2a0f6877551c',B='01a155c1-629a-7bd3-a99c-3b2924e0e6ae';
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'context-files-test-'));
 t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});});
 const skill=path.join(root,'SKILL.md'),instructions=path.join(root,'AGENTS.md');
 await fs.writeFile(skill,'Skill content');await fs.writeFile(instructions,'Instructions');
 for(const id of [A,B]){
  const state=id===A?{host_skills:{body:'- `r1` = `'+root+'`\n- sample: Description (file: r1/SKILL.md)'},agents_md:{[instructions]:'Instructions'},tools:{mcp__sample:'Search documents'}}:{};
  await fs.writeFile(path.join(root,`rollout-${id}.jsonl`),[
   {type:'session_meta',payload:{id,cwd:root}},
   {type:'world_state',payload:{full:true,state}},
   {type:'response_item',payload:{type:'function_call',name:'mcp__sample.search',arguments:'PRIVATE_ARGUMENTS'}},
  ].map(JSON.stringify).join('\n')+'\n');
 }
 const collector=new ContextCollector({sessionsRoot:root});
 return {root,skill,instructions,collector,files:new ContextFiles({collector,tempRoot:root})};
}
test('resolves skill aliases and opens actual skill/instruction files',async t=>{
 const f=await fixture(t);
 const s=await f.collector.getSnapshot(A);assert.equal(s.details.skills[0].path.replace(/\\/g,'/'),f.skill.replace(/\\/g,'/'));
 const skill=await f.files.prepare(A,'skills',s.details.skills[0].key);
 assert.equal(skill.path,await fs.realpath(f.skill));assert.equal(skill.kind,'source');
 const instructions=await f.files.prepare(A,'memory',f.instructions);
 assert.equal(instructions.path,await fs.realpath(f.instructions));
});
test('only items of the bound chat can be opened; missing files report an error',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.files.prepare(B,'skills','r1/SKILL.md'),/ITEM_NOT_FOUND/);
 await assert.rejects(f.files.prepare(A,'skills',path.join(f.root,'secret.txt')),/ITEM_NOT_FOUND/);
 await assert.rejects(f.files.prepare(A,'constructor','prototype'),/INVALID_GROUP/);
 await fs.unlink(f.skill);await assert.rejects(f.files.prepare(A,'skills','r1/SKILL.md'),/FILE_NOT_FOUND/);
});
test('tool cards show available descriptions without call arguments and reuse a file',async t=>{
 const f=await fixture(t);const a=await f.files.prepare(A,'deferredMcp','mcp__sample');
 assert.equal(a.kind,'tool-card');assert.match(await fs.readFile(a.path,'utf8'),/Search documents/);
 const b=await f.files.prepare(A,'mcp','mcp__sample.search');const text=await fs.readFile(b.path,'utf8');
 assert.match(text,/Search documents/);assert.match(text,/недоступна/);assert.doesNotMatch(text,/PRIVATE_ARGUMENTS/);
 assert.equal((await f.files.prepare(A,'mcp','mcp__sample.search')).path,b.path);
});
