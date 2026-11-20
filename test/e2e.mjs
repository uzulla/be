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
  const n0 = await ev(`document.getElementById('name').value`)
  check('新規のファイル名に作成日時が入る', /^untitled-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/.test(n0) && await ev('document.title') === n0, n0)

  await ev(`document.getElementById('t').focus()`)
  await send('Input.insertText', { text: 'hello\nworld' })
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await ev(`document.getElementById('name').select()`)
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

  // ---- 複製 ----
  await ev(`[...document.querySelectorAll('#recent a')].find(a => a.textContent === 'memo.md').click()`)
  await ev(`document.getElementById('dup').click()`)
  const p4 = await ev('location.pathname')
  check('複製: 新しい UUID に内容とファイル名がコピーされる', p4 !== p1 &&
    await ev(`document.getElementById('t').value + '|' + document.getElementById('name').value`) === 'hello\nworld\t|memo.md' &&
    await ev(`localStorage.getItem('be:doc:${p4.slice(1)}')`) === 'hello\nworld\t')

  // ---- クラウド保存 ----
  const val = () => ev(`document.getElementById('t').value`)
  const cloud = () => ev(`document.getElementById('cloud').textContent`)
  const warn = () => ev(`!document.getElementById('warn').hidden`)
  const type = async text => { await ev(`document.getElementById('t').focus()`); await send('Input.insertText', { text }); await sleep(400) }
  const click = async elId => { await ev(`document.getElementById('${elId}').click()`); await sleep(400) }
  const remote = () => ev(`fetch('/api/doc/' + location.pathname.slice(1)).then(async r => r.status + '|' + decodeURIComponent(r.headers.get('x-name') || '') + '|' + await r.text())`)
  // 別の PC からの保存を模擬する
  const remotePut = text => ev(`(async () => {
    const u = '/api/doc/' + location.pathname.slice(1)
    const v = (await fetch(u)).headers.get('x-version')
    return (await fetch(u, { method: 'PUT', headers: { 'x-base': v, 'x-name': 'other.md' }, body: ${JSON.stringify(text)} })).status
  })()`)

  await ev(`document.getElementById('new').click()`)
  const p5 = await ev('location.pathname')
  check('クラウド: 未保存のものは 404', (await remote()).startsWith('404'))
  await type('v1')
  await ev(`document.getElementById('name').select()`); await send('Input.insertText', { text: 'メモ.md' }); await sleep(400)
  check('クラウド: 変更があると未保存マーク', await cloud() === '☁ ●')
  await click('cloud')
  check('クラウド: ボタンで保存され、保存済みマークになる', await cloud() === '☁ ✓' && await remote() === '200|メモ.md|v1', await remote())

  check('別の場所からの保存(模擬)', await remotePut('remote edit') === 200)
  await type('x')
  await click('cloud')
  check('競合: 上書きせず警告を出す', await warn() && await cloud() === '☁ ⚠' && await remote() === '200|other.md|remote edit')
  await click('overwrite')
  check('競合: 「上書き」でローカルの内容が保存される', !(await warn()) && await cloud() === '☁ ✓' && (await remote()).endsWith('|' + await val()), await remote())

  await remotePut('remote edit 2')
  await type('y')
  await click('cloud')
  check('競合: 再び警告', await warn())
  await click('usecloud')
  check('競合: 「クラウド版を読みこむ」で置きかわる', !(await warn()) && await val() === 'remote edit 2' &&
    await ev(`document.getElementById('name').value`) === 'other.md' && await cloud() === '☁ ✓')

  await remotePut('remote edit 3')
  await goto(BASE + p5)
  check('ひらいたとき、ローカルに変更がなければクラウドの新しい版を取りこむ', await val() === 'remote edit 3' && !(await warn()))

  await remotePut('remote edit 4')
  await ev(`(() => { const k = 'be:doc:' + location.pathname.slice(1); localStorage.setItem(k, 'offline edit')
    const i = JSON.parse(localStorage.getItem('be:index')); i[location.pathname.slice(1)].d = 1; localStorage.setItem('be:index', JSON.stringify(i)) })()`)
  await goto(BASE + p5)
  check('ひらいたとき、両方に変更があれば警告を出す', await warn() && await val() === 'offline edit')
  await click('overwrite')

  await ev('localStorage.clear()')
  await goto(BASE + p5)
  check('別の PC(ローカルに無い)でも UUID でクラウドから読みだせる', await val() === 'offline edit' && await cloud() === '☁ ✓', await val())

  await ev(`window._fetch = window.fetch; window.fetch = () => Promise.reject(new Error('offline'))`)
  await type('z')
  await click('cloud')
  check('保存失敗: アイコンで示す', await cloud() === '☁ ⚠' && await ev(`document.getElementById('cloud').className`) === 'err' && !(await warn()))
  await ev(`window.fetch = window._fetch`)
  await sleep(10500)
  check('自動保存: 10 秒以内に再試行して保存される', await cloud() === '☁ ✓' && (await remote()).endsWith('|' + await val()), await cloud())

  check('API: UUID 以外は 404', await ev(`fetch('/api/doc/abc', { method: 'PUT', body: 'x' }).then(r => r.status)`) === 404)
  check('API: 256KB 超は 413', await ev(`fetch('/api/doc/' + crypto.randomUUID(), { method: 'PUT', body: 'x'.repeat(256 * 1024 + 1) }).then(r => r.status)`) === 413)
  check('API: 256KB ちょうどは保存できる', await ev(`fetch('/api/doc/' + crypto.randomUUID(), { method: 'PUT', body: 'x'.repeat(256 * 1024) }).then(r => r.status)`) === 200)
  await ev(`document.getElementById('new').click()`)
  await type('あ'.repeat(90000)) // UTF-8 で 270KB
  await click('cloud')
  check('256KB 超: 送信せずアイコンと説明で示す', await cloud() === '☁ ⚠' && (await ev(`document.getElementById('cloud').title`)).includes('256KB') && (await remote()).startsWith('404'))

  await goto(BASE + '/not-a-uuid')
  check('不正なパスは新規 UUID に置きかわる', UUID.test(await ev('location.pathname')))
  check('JS 例外なし', errors.length === 0, errors.join(' / '))
  ws.close()
} finally {
  chrome.kill()
}
console.log(failed ? `\n${failed} failed` : '\nall passed')
process.exit(failed ? 1 : 0)
