// Read-only inspection of the installed build for this feasibility probe.
const fs = require('node:fs');
const path = 'C:/Program Files/WindowsApps/OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0/app/resources/app.asar';
const fd = fs.openSync(path, 'r');
const pre = Buffer.alloc(16); fs.readSync(fd, pre, 0, 16, 0);
const raw = Buffer.alloc(pre.readUInt32LE(12)); fs.readSync(fd, raw, 0, raw.length, 16);
const index = JSON.parse(raw);
function read(name) { let item = index; for (const p of name.split('/')) item = item.files[p]; const b = Buffer.alloc(item.size); fs.readSync(fd, b, 0, b.length, 8 + pre.readUInt32LE(4) + Number(item.offset)); return b.toString(); }
const names = Object.keys(index.files.webview.files.assets.files).filter(n => n.endsWith('.js') && (process.argv[3] ? n.startsWith(process.argv[3]) : /^(view-queries|plugin-view-frame|widget-|app-initial-|app-shared-)/.test(n)));
const rx = new RegExp(process.argv[2] || 'openai/session|threadId|conversationId', 'g');
for (const name of names) { const content = read('webview/assets/' + name); let count = 0; for (const m of content.matchAll(rx)) { console.log(name + ': ' + content.slice(Math.max(0,m.index-220),m.index+700)); if (++count >= 4) break; } }
fs.closeSync(fd);
