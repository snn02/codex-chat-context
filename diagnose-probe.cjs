// Uses the installed app-server protocol, without starting a chat/model turn.
const {spawn}=require('node:child_process');
const readline=require('node:readline');
const fs=require('node:fs');
const executable='C:/Users/SAWA/AppData/Local/OpenAI/Codex/bin/9614f1d9b40d9c4f/codex.exe';
const args=['app-server','--stdio'];
const child=spawn(executable,args,{stdio:['pipe','pipe','pipe'],windowsHide:true});
const timer=setTimeout(()=>{console.error('Timeout after 35 seconds');child.kill();process.exitCode=1},35000);
let errors='';child.stderr.on('data',b=>{errors+=b.toString();});
let receivedStatus=false;
const send=(id,method,params)=>child.stdin.write(JSON.stringify({id,method,params})+'\n');
readline.createInterface({input:child.stdout}).on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}
 if(m.id===1){if(m.error){console.log(JSON.stringify(m));child.kill();return}child.stdin.write(JSON.stringify({method:'initialized'})+'\n');send(2,'mcpServerStatus/list',{serverName:process.argv[2]||'context_panel_probe',detail:'full'});}
 if(m.id===2){receivedStatus=!m.error;fs.writeFileSync('probe-app-server-status.json',JSON.stringify({checkedAt:new Date().toISOString(),source:'separate read-only app-server diagnostic; not a UI open',response:m},null,2));console.log(JSON.stringify(m,null,2));child.stdin.end();child.kill();}
});
child.on('exit',()=>{clearTimeout(timer);if(!receivedStatus)process.exitCode=1;const filtered=errors.split('\n').filter(l=>/context.panel.probe|invalid|parse|error/i.test(l));console.error(filtered.slice(-12).join('\n'));});
send(1,'initialize',{clientInfo:{name:'context_probe_diagnostic',version:'0.1.0'},capabilities:{experimentalApi:true}});
