import http from 'node:http'
import os from 'node:os'
import crypto from 'node:crypto'

let server = null
let token = ''
let port = 18787
let clients = 0
let snapshot = () => ({ workspace: '', sessions: [] })
const live = new Map()

export function setSnapshot(fn) {
  snapshot = fn
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

function urlsFor(p, tok) {
  const ifaces = os.networkInterfaces()
  const ips = []
  for (const list of Object.values(ifaces)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) ips.push(item.address)
    }
  }
  if (!ips.includes('127.0.0.1')) ips.unshift('127.0.0.1')
  return ips.map((ip) => `http://${ip}:${p}/?t=${tok}`)
}

function page() {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi-My 观察</title>
<style>
body{margin:0;font:14px/1.5 system-ui;background:#111;color:#eee;padding:16px}
h1{font-size:16px;margin:0 0 12px}
.card{border:1px solid #333;border-radius:10px;padding:12px;margin:0 0 10px;background:#1a1a1a}
.tail{white-space:pre-wrap;color:#bbb;font:12px/1.45 ui-monospace,monospace;max-height:180px;overflow:auto}
.run{color:#9f9}
</style>
<h1>Pi-My 局域网观察</h1>
<div id="root">加载中…</div>
<script>
const t=new URLSearchParams(location.search).get('t')||''
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
async function tick(){
  const res=await fetch('/api/view?t='+encodeURIComponent(t))
  const data=await res.json()
  root.innerHTML='<p>工作区 '+ esc(data.workspace||'') +' · '+ (data.sessions||[]).length +' 个会话</p>'+(data.sessions||[]).map(s=>'<div class="card"><strong>'+esc(s.title||s.id)+'</strong> <span class="'+(s.running?'run':'')+'">'+(s.running?'运行中':'空闲')+'</span>'+(s.tool?'<div>工具 '+esc(s.tool)+'</div>':'')+(s.tail?'<div class="tail">'+esc(s.tail)+'</div>':'')+'</div>').join('')||'<p>暂无会话</p>'
}
tick(); setInterval(tick,2000)
</script>`
}

function authorized(req) {
  const url = new URL(req.url, 'http://127.0.0.1')
  return url.searchParams.get('t') === token
}

export function status() {
  return {
    enabled: Boolean(server),
    port: server ? port : null,
    clients,
    urls: server ? urlsFor(port, token) : [],
    token: server ? token : null
  }
}

export function stop() {
  if (!server) return status()
  server.close()
  server = null
  clients = 0
  return status()
}

export function start(preferred = 18787) {
  if (server) return status()
  token = crypto.randomBytes(8).toString('hex')
  port = preferred
  server = http.createServer((req, res) => {
    if (!authorized(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('unauthorized')
      return
    }
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/api/view') {
      const data = snapshot()
      const sessions = (data.sessions || []).map((item) => ({ ...item, ...(live.get(item.id) || {}) }))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify({ workspace: data.workspace, sessions }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page())
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
