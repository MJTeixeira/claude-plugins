// One request to `codex app-server`, which answers account and model questions
// without starting a model turn. Resolves with the result; exits 1 naming what
// failed, as `<name>: <reason>`.
import { spawn } from 'node:child_process'
import { command } from './command.mjs'

export function request(name, method, params) {
  const started = command('codex', ['app-server'])
  const server = spawn(started.file, started.args, { ...started.options, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const send = message => server.stdin.write(`${JSON.stringify(message)}\n`)
  const fail = reason => {
    console.error(`${name}: ${reason}`)
    server.kill()
    process.exit(1)
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => fail('no answer in 20 s'), 20_000)
    let buffer = ''
    server.stdout.on('data', chunk => {
      buffer += chunk
      let end = buffer.indexOf('\n')
      for (; end >= 0; end = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        if (message.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method, ...(params === undefined ? {} : { params }) })
        }
        if (message.id === 2) {
          if (!message.result) fail(JSON.stringify(message.error))
          clearTimeout(timer)
          server.kill()
          resolve(message.result)
        }
      }
    })
    server.on('error', error => fail(error.message))
    send({ id: 1, method: 'initialize', params: { clientInfo: { name, version: '1' } } })
  })
}
