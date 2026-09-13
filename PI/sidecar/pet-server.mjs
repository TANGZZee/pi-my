import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

let server = null
let root = ''
let port = 18789

const MIME = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.moc3': 'application/octet-stream',
  '.moc': 'application/octet-stream',
  '.mtn': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
}

export function startPetServer(agentDir, preferred = 18789) {
  if (server) return port
  root = path.join(agentDir, 'pets')
  port = preferred
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const target = path.normalize(path.join(root, rel))
      if (target !== root && !target.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return }
      const data = await readFile(target)
      const ext = path.extname(target).toLowerCase()
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=86400'
      })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  server.on('error', () => {
    try { server?.close() } catch {}
    server = null
  })
  server.listen(port, '127.0.0.1')
  return port
}

export function petServerPort() {
  return server ? port : null
}

export function petServerBase() {
  return server ? `http://127.0.0.1:${port}` : null
}
