import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BASE = process.env.BASE || 'http://localhost:8787', PORT = 9333
const dir = mkdtempSync(join(tmpdir(), 'be-chrome-'))
const chrome = spawn(process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'],
  { stdio: 'ignore' })
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (label, ok, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`) }

try {
  let target
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200)
    try { target = (await (await fetch(`http://localhost:${PORT}/json`)).json()).find(t => t.type === 'page') } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(r => ws.onopen = r)
  let seq = 0; const pending = new Map(), errors = []
  ws.onmessage = m => {
    const d = JSON.parse(m.data)
    if (d.id) { pending.get(d.id)(d); pending.delete(d.id) }
    else if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)
  }
  const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description)
    return r.result.result.value
  }
  const goto = async url => { await send('Page.navigate', { url }); await sleep(500) }
  await send('Runtime.enable'); await send('Page.enable')
  const UUID = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

  await goto(BASE + '/')
  const p1 = await ev('location.pathname')
  check('/ で UUID が発番される', UUID.test(p1), p1)
  check('空の新規は保存されない', await ev('localStorage.length') === 0)

  await ev(`document.getElementById('t').focus()`)
  await send('Input.insertText', { text: 'hello\nworld' })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await ev(`document.getElementById('name').focus()`)
  await send('Input.insertText', { text: 'memo.md' })
  await sleep(500)
  check('本文が UUID キーで保存される', await ev(`localStorage.getItem('be:doc:' + location.pathname.slice(1))`) === 'hello\nworld\t')
  check('ファイル名がインデックスに保存される', await ev(`JSON.parse(localStorage.getItem('be:index'))[location.pathname.slice(1)].n`) === 'memo.md')
  check('status が Saved', await ev(`document.getElementById('status').textContent`) === 'Saved')
  check('title がファイル名', await ev('document.title') === 'memo.md')

  await goto(BASE + p1)
  check('リロードで復元される', await ev(`document.getElementById('t').value + '|' + document.getElementById('name').value`) === 'hello\nworld\t|memo.md')

  await ev(`document.getElementById('new').click()`)
  const p2 = await ev('location.pathname')
  check('New で別の UUID・空になる', UUID.test(p2) && p2 !== p1 && await ev(`document.getElementById('t').value`) === '')

  // DnD: 空ドキュメントにはその場で読みこむ
  const drop = files => ev(`(async () => {
    const dt = new DataTransfer()
    for (const [n, c] of ${JSON.stringify(files)}) dt.items.add(new File([c], n, { type: 'text/plain' }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    await new Promise(r => setTimeout(r, 200))
  })()`)
  await drop([['dropped.txt', 'from file ✓']])
  check('DnD: 空ドキュメントに読みこまれる', await ev('location.pathname') === p2 &&
    await ev(`document.getElementById('t').value + '|' + document.getElementById('name').value`) === 'from file ✓|dropped.txt')
  await drop([['a.txt', 'AAA'], ['b.txt', 'BBB']])
  const p3 = await ev('location.pathname')
  check('DnD: 内容があるときは新しい UUID でひらく', p3 !== p2 && await ev(`document.getElementById('t').value`) === 'AAA')
  check('DnD: 複数ファイルはすべて保存される', await ev(`Object.keys(JSON.parse(localStorage.getItem('be:index'))).length`) === 4)

  await ev(`document.getElementById('recent').showPopover()`)
  const names = await ev(`[...document.querySelectorAll('#recent a')].map(a => a.textContent).sort().join(',')`)
  check('Recent に一覧が出る', names === 'a.txt,b.txt,dropped.txt,memo.md', names)
  check('Recent で現在のものが強調される', await ev(`document.querySelector('#recent .cur a').textContent`) === 'a.txt')
  await ev(`[...document.querySelectorAll('#recent a')].find(a => a.textContent === 'memo.md').click()`)
  check('Recent からひらける', await ev('location.pathname') === p1 && await ev(`document.getElementById('t').value`) === 'hello\nworld\t')
  check('ひらくと popover が閉じる', await ev(`!document.getElementById('recent').matches(':popover-open')`))

  await ev('history.back()'); await sleep(200)
  check('戻るで前のドキュメントになる', await ev('location.pathname') === p3 && await ev(`document.getElementById('t').value`) === 'AAA')

  const dl = await ev(`(async () => {
    let got; const orig = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () { got = this }
    document.getElementById('dl').click()
    HTMLAnchorElement.prototype.click = orig
    return got.download + '|' + await (await fetch(got.href)).text()
  })()`)
  check('Download: ファイル名と内容', dl === 'a.txt|AAA', dl)

  // 削除 (confirm は自動で OK)
  await ev(`window.confirm = () => true; document.getElementById('recent').showPopover(); document.querySelector('#recent .cur [data-del]').click()`)
  check('削除: ストレージから消え、新規になる', await ev(`localStorage.getItem('be:doc:${p3.slice(1)}')`) === null &&
    await ev('location.pathname') !== p3 && await ev(`Object.keys(JSON.parse(localStorage.getItem('be:index'))).length`) === 3)

  await goto(BASE + '/not-a-uuid')
  check('不正なパスは新規 UUID に置きかわる', UUID.test(await ev('location.pathname')))
  check('JS 例外なし', errors.length === 0, errors.join(' / '))
  ws.close()
} finally {
  chrome.kill()
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
