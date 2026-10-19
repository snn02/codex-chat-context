'use strict';
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');
class ContextFiles {
  constructor({collector,tempRoot=os.tmpdir()}) {this.collector=collector;this.tempRoot=tempRoot;this.directory=null;this.jobs=new Map();}
  async prepare(id,group,key) {
    const item=await this.collector.getItem(id,group,key);
    if(group==='skills'||group==='memory') {
      // Accept only a path already present in this chat, never a caller-provided path.
      if(!path.isAbsolute(item.path)||path.extname(item.path).toLowerCase()!=='.md'||/^(?:\\\\|\/\/)/.test(item.path))throw Error('FILE_PATH_UNAVAILABLE');
      let actual,stat;
      try {actual=await fs.realpath(item.path);stat=await fs.stat(actual);}catch(e){if(e.code==='ENOENT')throw Error('FILE_NOT_FOUND');throw e;}
      if(!stat.isFile())throw Error('NOT_A_FILE');
      return {threadId:item.threadId,path:actual,kind:'source',name:item.name};
    }
    // Tools need not have a source file: create an explicitly labelled local information card.
    const hash=crypto.createHash('sha256').update(item.threadId+'\0'+group+'\0'+key).digest('hex');
    if(this.jobs.has(hash))return this.jobs.get(hash);
    const job=this.writeCard(item,hash);this.jobs.set(hash,job);
    try{return await job;}finally{this.jobs.delete(hash);}
  }
  async writeCard(item,hash) {
    if(!this.directory)this.directory=fs.mkdtemp(path.join(this.tempRoot,'codex-context-files-')).catch(e=>{this.directory=null;throw e;});
    const root=await this.directory,file=path.join(root,hash+'.txt');
    const body=[`Инструмент: ${item.name}`,'','Локальная карточка панели контекста. Это описание, а не исходный код инструмента.',
      `Чат: ${item.threadId}`,`Источник: ${item.descriptionSource?'каталог '+item.descriptionSource:'наблюдавшийся вызов в журнале'}`,'',
      item.description||'Описание инструмента недоступно в локальном журнале.','',
      'Полная схема параметров недоступна в используемом источнике.',
      'Параметры и результаты прошлых вызовов в эту карточку не включаются.',''].join('\n');
    let previous;try{previous=await fs.readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
    if(previous!==body)await fs.writeFile(file,body,{encoding:'utf8',mode:0o600});
    return {threadId:item.threadId,path:file,kind:'tool-card',name:item.name};
  }
}
module.exports={ContextFiles};
