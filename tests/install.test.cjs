const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const shells = process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : [];

for (const shell of shells) {
  if (spawnSync(shell, ['-NoProfile','-Command','exit 0']).status !== 0) continue;
  function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-install-'));
    t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const repo = path.join(dir, 'project with spaces тест');
    const plugin = path.join(repo,'marketplace','plugins','context-panel-probe');
    fs.mkdirSync(plugin,{recursive:true});
    fs.copyFileSync(path.join(root,'install.ps1'),path.join(repo,'install.ps1'));
    fs.writeFileSync(path.join(plugin,'server.cjs'),"'use strict';\n");
    const config = path.join(plugin,'.mcp.json');
    const original = JSON.stringify({mcpServers:{context_panel_probe:{command:'old-node',args:['old-server'],enabled:false,env:{KEEP:'yes'}},other:{command:'keep'}}});
    fs.writeFileSync(config,original);
    const cli = path.join(dir,'codex.cmd');
    const calls = path.join(dir,'calls.jsonl');
    fs.writeFileSync(path.join(dir,'fake codex.ps1'),`$ErrorActionPreference = 'Stop'
ConvertTo-Json -InputObject @($args) -Compress | Add-Content -LiteralPath $env:INSTALL_TEST_CALLS -Encoding UTF8
if ($args -contains '--help') { if ($env:INSTALL_TEST_FAIL -eq 'help') { exit 2 }; Write-Output 'supported'; exit 0 }
if ($args[1] -eq 'marketplace' -and $env:INSTALL_TEST_FAIL -eq 'marketplace') { Write-Output 'registration failed'; exit 3 }
if ($args[1] -eq 'add' -and $env:INSTALL_TEST_FAIL -eq 'install') { Write-Output 'installation failed'; exit 4 }
Write-Output 'ok'
exit 0
`);
    fs.writeFileSync(cli,'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0fake codex.ps1" %*\r\nexit /b %errorlevel%\r\n');
    const run=(fail='',node=process.execPath,auto=false)=>spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(repo,'install.ps1'),...(auto?[]:['-NodePath',node,'-CodexPath',cli])],{cwd:dir,env:{...process.env,Path:dir+path.delimiter+process.env.Path,INSTALL_TEST_CALLS:calls,INSTALL_TEST_FAIL:fail},encoding:'utf8',timeout:30000});
    const readCalls=()=>fs.existsSync(calls)?fs.readFileSync(calls,'utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x.replace(/^\uFEFF/,''))):[];
    return {dir,repo,plugin,config,original,run,readCalls};
  }
  test(`${shell}: installs from any working directory and repeats without losing config`,t=>{
    const f=fixture(t);
    for(let i=0;i<2;i++) {
      const result=f.run();assert.equal(result.status,0,result.stdout+result.stderr);
      const c=JSON.parse(fs.readFileSync(f.config,'utf8'));
      assert.equal(c.mcpServers.context_panel_probe.command,process.execPath);
      assert.deepEqual(c.mcpServers.context_panel_probe.args,[path.join(f.plugin,'server.cjs')]);
      assert.equal(c.mcpServers.context_panel_probe.enabled,true);
      assert.equal(c.mcpServers.context_panel_probe.env.KEEP,'yes');assert.equal(c.mcpServers.other.command,'keep');
    }
    const mutations=f.readCalls().filter(a=>!a.includes('--help'));
    assert.deepEqual(mutations,[['plugin','marketplace','add',path.join(f.repo,'marketplace')],['plugin','add','context-panel-probe@context-panel-probe-local'],['plugin','marketplace','add',path.join(f.repo,'marketplace')],['plugin','add','context-panel-probe@context-panel-probe-local']]);
  });
  for(const fail of ['help','marketplace','install'])test(`${shell}: ${fail} failure is reported and original config retained`,t=>{
    const f=fixture(t);const result=f.run(fail);assert.notEqual(result.status,0,result.stdout+result.stderr);
    assert.equal(fs.readFileSync(f.config,'utf8'),f.original);
    const mutations=f.readCalls().filter(a=>!a.includes('--help'));
    assert.equal(mutations.length,fail==='help'?0:fail==='marketplace'?1:2);
    assert.doesNotMatch(result.stdout,/Installation complete/);
  });
  test(`${shell}: missing Node fails before touching config or registering marketplace`,t=>{
    const f=fixture(t);const result=f.run('',path.join(f.dir,'absent-node.exe'));assert.notEqual(result.status,0);
    assert.equal(fs.readFileSync(f.config,'utf8'),f.original);assert.deepEqual(f.readCalls(),[]);
  });
  test(`${shell}: discovers Node and Codex from PATH without explicit parameters`,t=>{
    const f=fixture(t);const result=f.run('',undefined,true);assert.equal(result.status,0,result.stdout+result.stderr);
    assert.ok(f.readCalls().some(a=>a[0]==='plugin'&&a[1]==='add'&&!a.includes('--help')));
  });
  test(`${shell}: unsupported Node version stops before registering anything`,t=>{
    const f=fixture(t);const node=path.join(f.dir,'old-node.ps1');
    fs.writeFileSync(node,"Write-Output 'v18.0.0'\nexit 0\n");
    const result=f.run('',node);assert.notEqual(result.status,0);assert.match(result.stderr,/Node.js 20 or later/);
    assert.equal(fs.readFileSync(f.config,'utf8'),f.original);assert.deepEqual(f.readCalls(),[]);
  });
}
