import http from 'node:http'
import os from 'node:os'
import crypto from 'node:crypto'

let server = null
let token = ''
let port = 18787
let clients = 0
let snapshot = () => ({ workspace: '', sessions: [] })
const live = new Map()
// 1-6 可写能力：由 sidecar 注入的动作处理器（发 prompt / 停止 / 回答确认框）。
// 未注入或 writable=false 时，写接口一律 403 —— 只读是缺省。
let actions = null
let writable = false

export function setSnapshot(fn) {
  snapshot = fn
}

/** 注入可写动作与开关（index.mjs 在 lan_set 时调用）。 */
export function setActions(handlers, enabled) {
  actions = handlers ?? null
  writable = Boolean(enabled && handlers)
}

export function note(sessionId, event) {
  if (!sessionId || !event) return
  const cur = live.get(sessionId) || { running: false, tool: '', tail: '', title: sessionId }
  if (event.type === 'agent_start') cur.running = true
  if (event.type === 'agent_end' || event.type === 'error') cur.running = false
  if (event.type === 'tool_execution_start') cur.tool = String(event.toolName || '工具')
  if (event.type === 'tool_execution_end') cur.tool = ''
  if (event.type === 'message_update' && event.delta) cur.tail = `${cur.tail || ''}${event.delta}`.slice(-800)
  live.set(sessionId, cur)
}

/** 只读访问某会话的实时快照（index.mjs 组装 lan_set 快照用）。 */
export function peek(sessionId) {
  return live.get(sessionId) || null
}

function urlsFor(p, tok, isWritable) {
  const ifaces = os.networkInterfaces()
  const ips = []
  for (const list of Object.values(ifaces)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) ips.push(item.address)
    }
  }
  if (!ips.includes('127.0.0.1')) ips.unshift('127.0.0.1')
  // 1-6 安全修复：token 不再走 URL query（会进浏览器历史/REFERER）。
  // 页面本身仍用 ?t= 做首次进入（引导页无副作用），进入后 token 存
  // sessionStorage，后续 API 全部走 x-pi-token header。
  return ips.map((ip) => `http://${ip}:${p}/?t=${tok}${isWritable ? '（可写模式）' : ''}`)
}

function page(writable) {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi-My ${writable ? '遥控' : '观察'}</title>
<style>
body{margin:0;font:14px/1.5 system-ui;background:#111;color:#eee;padding:16px}
h1{font-size:16px;margin:0 0 12px}
.card{border:1px solid #333;border-radius:10px;padding:12px;margin:0 0 10px;background:#1a1a1a}
.tail{white-space:pre-wrap;color:#bbb;font:12px/1.45 ui-monospace,monospace;max-height:180px;overflow:auto}
.run{color:#9f9}
button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid #444;background:#262626;color:#eee;margin:2px 4px 2px 0}
button.primary{background:#2f6f4f;border-color:#3d8f66}
textarea{width:100%;box-sizing:border-box;font:inherit;padding:8px;border-radius:8px;border:1px solid #444;background:#111;color:#eee;min-height:64px}
.row{display:flex;gap:8px;margin:6px 0}
.badge{font-size:11px;color:#8cf;border:1px solid #46a;border-radius:6px;padding:1px 6px}
dialog{background:#1a1a1a;color:#eee;border:1px solid #444;border-radius:10px;max-width:420px;width:92%}
.confirm-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.warn{color:#fc6;font-size:12px}
</style>
<h1>Pi-My 局域网${writable ? '遥控' : '观察'}${writable ? ' <span class="badge">可写</span>' : ''}</h1>
${writable ? '<p class="warn">可写模式已开启：本页可向会话发送消息、停止生成、回答权限确认。请仅在可信网络使用。</p>' : ''}
<div id="root">加载中…</div>
<dialog id="dlg"><div id="dlg-body"></div><div class="confirm-actions"><button onclick="dlg.close();dlgResolve(false)">拒绝</button><button class="primary" onclick="dlg.close();dlgResolve(true)">允许</button></div></dialog>
<script>
const t=new URLSearchParams(location.search).get('t')||''
if(t)sessionStorage.setItem('pi-lan-token',t)
const tok=()=>sessionStorage.getItem('pi-lan-token')||''
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
let sessions=[]
let selected=''
let confirmWaiters=[]
window.dlgResolve=(v)=>{const f=confirmWaiters.shift();if(f)f(v)}
async function api(path,opts){
  const res=await fetch(path,{...opts,headers:{'x-pi-token':tok(),'content-type':'application/json',...(opts&&opts.headers||{})}})
  if(res.status===401)throw new Error('token 失效，请从主界面重新获取链接')
  return res.json()
}
async function sendPrompt(id,text){
  try{const r=await api('/api/prompt',{method:'POST',body:JSON.stringify({sessionId:id,text})});if(!r.ok)alert(r.error||'发送失败')}catch(e){alert(e.message)}
  tick()
}
async function sendSteer(id,text){
  try{const r=await api('/api/steer',{method:'POST',body:JSON.stringify({sessionId:id,text})});if(!r.ok)alert(r.error||'发送失败')}catch(e){alert(e.message)}
  tick()
}
async function stopRun(id){
  try{await api('/api/stop',{method:'POST',body:JSON.stringify({sessionId:id})})}catch(e){alert(e.message)}
  tick()
}
async function answerConfirm(dialogId,confirmed){
  try{await api('/api/confirm',{method:'POST',body:JSON.stringify({dialogId,confirmed})})}catch(e){alert(e.message)}
  tick()
}
function askConfirm(title,message){return new Promise(v=>{confirmWaiters.push(v);dlgBody.innerHTML='<strong>'+esc(title)+'</strong><div class="tail">'+esc(message)+'</div>';dlg.showModal()})}
function render(){
  root.innerHTML='<p>工作区 '+esc(data.workspace||'')+' · '+sessions.length+' 个会话</p>'+sessions.map(s=>
    '<div class="card"><strong>'+esc(s.title||s.id)+'</strong> <span class="'+(s.running?'run':'')+'">'+(s.running?'运行中':'空闲')+'</span>'+
    '<div class="row"><button onclick="pick(\\''+s.id+'\\')">'+(selected===s.id?'已选中':'选中')+'</button>'+
    (selected===s.id&&${writable?'true':'false'}?(
      (s.running?'<button onclick="stopRun(\\''+s.id+'\\')">停止</button>':'')+
      (s.confirm?'<button class="primary" onclick="confirmCard(\\''+s.confirm.dialogId+'\\',\\''+esc(s.confirm.toolName)+'\\',\\''+esc(s.confirm.summary)+'\\')">权限确认：'+esc(s.confirm.toolName)+'</button>':'')
    ):'')+
    '</div>'+
    (s.tool?'<div>工具 '+esc(s.tool)+'</div>':'')+(s.tail?'<div class="tail">'+esc(s.tail)+'</div>':'')+
    (selected===s.id&&${writable?'true':'false'}?
      '<textarea id="box" placeholder="输入消息（运行中=插话，空闲=发送）">'+esc(drafts[s.id]||'')+'</textarea>'+
      '<div class="row"><button class="primary" onclick="submitBox(\\''+s.id+'\\')">发送</button></div>':'')+
    '</div>').join('')||'<p>暂无会话</p>'
  const box=document.getElementById('box')
  if(box&&selected)box.value=drafts[selected]||''
}
const drafts={}
window.pick=(id)=>{if(selected&&document.getElementById('box'))drafts[selected]=document.getElementById('box').value;selected=id;render()}
window.submitBox=(id)=>{const box=document.getElementById('box');const text=(box?box.value:'').trim();if(!text)return;drafts[id]='';const s=sessions.find(x=>x.id===id);if(s&&s.running)sendSteer(id,text);else sendPrompt(id,text)}
window.confirmCard=(dialogId,tool,summary)=>{askConfirm('权限确认：'+tool,summary).then(v=>answerConfirm(dialogId,v))}
let data={}
async function tick(){
  try{
    data=await api('/api/view')
    sessions=data.sessions||[]
    render()
  }catch(e){root.innerHTML='<p class="warn">'+esc(e.message)+'</p>'}
}
tick();setInterval(tick,2000)
</script>`
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
  res.end(JSON.stringify(body))
}

function authorized(req) {
  // 1-6 安全修复：API 请求优先校验 x-pi-token header；
  // 仅页面 HTML 允许 query ?t=（引导进入），API 一律不再接受 query token。
  const header = String(req.headers['x-pi-token'] || '')
  if (header && header === token) return true
  const url = new URL(req.url, 'http://127.0.0.1')
  // 页面请求（浏览器地址栏/刷新）保留 query 通道
  if (url.pathname === '/' && url.searchParams.get('t') === token) return true
  return false
}

async function readBody(req, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('请求体不是有效 JSON'))
      }
    })
    req.on('error', reject)
  })
}

export function status() {
  return {
    enabled: Boolean(server),
    writable,
    port: server ? port : null,
    clients,
    urls: server ? urlsFor(port, token, writable) : [],
    token: server ? token : null,
  }
}

export function stop() {
  if (!server) return status()
  server.close()
  server = null
  clients = 0
  writable = false
  actions = null
  return status()
}

export function start(preferred = 18787) {
  if (server) return status()
  token = crypto.randomBytes(8).toString('hex')
  port = preferred
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    // 1-6：写接口先于鉴权之外判断"是否可写模式"，避免只读模式下泄露接口存在性
    const isWriteApi = url.pathname.startsWith('/api/prompt') || url.pathname.startsWith('/api/steer') || url.pathname.startsWith('/api/stop') || url.pathname.startsWith('/api/confirm')
    if (isWriteApi && !writable) {
      json(res, 403, { ok: false, error: '只读模式：需在设置中开启"允许远程写入"' })
      return
    }
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('unauthorized')
      return
    }
    if (url.pathname === '/api/view') {
      const data = snapshot()
      const sessions = (data.sessions || []).map((item) => ({ ...item, ...(live.get(item.id) || {}) }))
      json(res, 200, { workspace: data.workspace, sessions, writable })
      return
    }
    if (isWriteApi) {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: '仅支持 POST' })
        return
      }
      if (!actions) {
        json(res, 503, { ok: false, error: '动作处理器未就绪' })
        return
      }
      try {
        const body = await readBody(req)
        let result
        if (url.pathname === '/api/prompt') result = await actions.prompt(body)
        else if (url.pathname === '/api/steer') result = await actions.steer(body)
        else if (url.pathname === '/api/stop') result = await actions.stop(body)
        else if (url.pathname === '/api/confirm') result = await actions.confirm(body)
        else result = { ok: false, error: '未知接口' }
        json(res, 200, result)
      } catch (error) {
        json(res, 400, { ok: false, error: error.message || '请求无效' })
      }
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page(writable))
  })
  server.on('connection', (socket) => {
    clients += 1
    socket.on('close', () => { clients = Math.max(0, clients - 1) })
  })
  server.on('error', () => {
    try { server?.close() } catch { /* ignore */ }
    server = null
    clients = 0
  })
  server.listen(port, '0.0.0.0')
  return status()
}
