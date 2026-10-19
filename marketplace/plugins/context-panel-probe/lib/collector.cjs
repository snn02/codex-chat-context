'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createState,consume,snapshot}=require('./context.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
class ContextCollector {
  constructor({sessionsRoot=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'sessions'),chunkBytes=2*1024*1024,maxRecordBytes=8*1024*1024,maxCacheEntries=8}={}) {
    this.root=path.resolve(sessionsRoot);this.chunkBytes=chunkBytes;this.maxRecordBytes=maxRecordBytes;this.maxCacheEntries=maxCacheEntries;this.cache=new Map();
  }
  async findFile(id) {
    const dirs=[this.root];let visited=0;
    while(dirs.length) {
      const dir=dirs.pop();let entries;
      try{entries=await fs.readdir(dir,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')continue;throw e;}
      for(const entry of entries) {
        if(++visited>100000)throw new Error('SESSION_INDEX_TOO_LARGE');
        if(entry.isSymbolicLink())continue;
        const full=path.join(dir,entry.name);
        if(entry.isDirectory())dirs.push(full);
        else if(entry.isFile()&&entry.name.endsWith(id+'.jsonl'))return full;
      }
    }
    return null;
  }
  fresh(id,file=null) {return {id,file,state:createState(id),offset:0,tail:Buffer.alloc(0),skipLine:false,checkpoint:null,birth:null,pending:0,task:Promise.resolve(),loading:false};}
  async getSnapshot(id,options={}) {
    if(typeof id!=='string'||!UUID.test(id))throw new Error('INVALID_THREAD_ID');
    id=id.toLowerCase();let entry=this.cache.get(id);
    if(!entry){entry=this.fresh(id);this.cache.set(id,entry);}
    this.cache.delete(id);this.cache.set(id,entry);
    entry.pending++;
    const read=entry.task.then(()=>this.update(entry));entry.task=read.catch(()=>{});
    try {
      await read;
      // Never publish any data from a stream until its own metadata matches the host.
      const result=snapshot(entry.state.sessionVerified?entry.state:createState(id),options);
      if(!entry.file)result.status='no_session';
      else if(entry.loading)result.status='loading';
      else if(!entry.state.sessionVerified)throw new Error('SESSION_METADATA_MISSING');
      result.readProgress=entry.size?Math.min(1,entry.offset/entry.size):0;
      return result;
    } finally {
      entry.pending--;
      for(const [key,value] of this.cache) {
        if(this.cache.size<=this.maxCacheEntries)break;
        if(!value.pending)this.cache.delete(key);
      }
    }
  }
  async checkpoint(handle,offset) {
    const from=Math.max(0,offset-128),buf=Buffer.alloc(offset-from);
    if(buf.length)await handle.read(buf,0,buf.length,from);
    return buf;
  }
  async getItem(id,group,key) {
    if(!['skills','memory','mcp','systemTools','deferredMcp','deferredSystem'].includes(group))throw Error('INVALID_GROUP');
    if(typeof key!=='string'||!key||key.length>4096)throw Error('INVALID_ITEM_KEY');
    await this.getSnapshot(id);
    const state=this.cache.get(id.toLowerCase())?.state;
    if(!state?.sessionVerified)throw Error('SESSION_METADATA_MISSING');
    const item=state.details[group].get(key);
    if(!item)throw Error('ITEM_NOT_FOUND');
    const namespace=[...state.toolDescriptions.keys()].filter(name=>item.name===name||item.name.startsWith(name+'.')||item.name.startsWith(name+'__')).sort((a,b)=>b.length-a.length)[0];
    return {...item,group,threadId:state.threadId,description:namespace?state.toolDescriptions.get(namespace):null,descriptionSource:namespace||null};
  }
  async update(entry) {
    if(!entry.file)entry.file=await this.findFile(entry.id);
    if(!entry.file)return;
    let handle;
    try {handle=await fs.open(entry.file,'r');}
    catch(e) {if(e.code==='ENOENT'){Object.assign(entry,this.fresh(entry.id),{pending:entry.pending,task:entry.task});return;}throw e;}
    try {
      const stat=await handle.stat();
      const rewritten=entry.mtime!==undefined&&entry.mtime!==stat.mtimeMs&&stat.size<=entry.size;
      const changed=entry.birth!==null&&entry.birth!==stat.birthtimeMs;
      const oldCheckpoint=entry.checkpoint&&await this.checkpoint(handle,entry.offset);
      if(changed||rewritten||stat.size<entry.offset||(oldCheckpoint&&!oldCheckpoint.equals(entry.checkpoint))) {
        entry.state=createState(entry.id);entry.offset=0;entry.tail=Buffer.alloc(0);entry.skipLine=false;entry.checkpoint=null;
      }
      entry.birth=stat.birthtimeMs;entry.mtime=stat.mtimeMs;entry.size=stat.size;
      const length=Math.min(this.chunkBytes,Math.max(0,stat.size-entry.offset));
      if(length) {
        const buffer=Buffer.alloc(length);const {bytesRead}=await handle.read(buffer,0,length,entry.offset);entry.offset+=bytesRead;
        let data=Buffer.concat([entry.tail,buffer.subarray(0,bytesRead)]);let start=0,end;
        while((end=data.indexOf(10,start))!==-1) {
          const line=data.subarray(start,end);start=end+1;
          if(entry.skipLine){entry.skipLine=false;continue;}
          if(line.length>this.maxRecordBytes){entry.state.partial=true;continue;}
          if(!line.length)continue;
          let event;
          try{event=JSON.parse(line.toString('utf8'));}catch{entry.state.partial=true;continue;}
          consume(entry.state,event);
        }
        entry.tail=Buffer.from(data.subarray(start));
        if(entry.tail.length>this.maxRecordBytes){entry.tail=Buffer.alloc(0);entry.skipLine=true;entry.state.partial=true;}
      }
      entry.checkpoint=await this.checkpoint(handle,entry.offset);
      entry.loading=entry.offset<stat.size;
    } catch(e) {
      // A failed/mismatched stream cannot leave usable data in the cache.
      entry.state=createState(entry.id);entry.offset=0;entry.tail=Buffer.alloc(0);entry.checkpoint=null;
      throw e;
    } finally {await handle.close();}
  }
}
module.exports={ContextCollector};
