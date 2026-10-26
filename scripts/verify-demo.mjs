'use strict'

/* global fetch, WebSocket, AbortSignal */
// 以上三个是 Node 18+ 的运行时全局（undici 与 WHATWG WebSocket）。
// standard 的默认环境表不含它们，因此显式声明。
// 不用 --env browser 覆盖：那会同时放行 window/document，掩盖真实误用。

/**
 * 演示页验收（真实浏览器，非 jsdom）
 *
 * 为什么必须真浏览器：这个页面要证明"CLI 与浏览器跑同一套判定"，而 DOM 探针
 * 无法证明 canvas 真的画出了东西、也无法证明打包后的解码器真的能跑。
 *
 * 流程：headless Edge/Chrome → 打开 file://demo/index.html → 等报告渲染 →
 *       读判定文本 + 统计 canvas 像素 + 收集 console 错误 → 截图落盘。
 *
 * 用法：
 *   node scripts/verify-demo.mjs                 # 验收本地 demo/index.html（file://）
 *   node scripts/verify-demo.mjs --url <URL>     # 验收已部署的线上页面
 *   node scripts/verify-demo.mjs --keep          # 跑完不关浏览器，便于手动看
 *
 * 退出码：0 全通过 / 1 有断言失败 / 2 环境不可用
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PNG } from 'pngjs'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = Number(process.env.CDP_PORT || 12031)
const PROFILE = join(ROOT, '.probe/cdp-profile')
const SHOTS = join(ROOT, 'shots/verify')

// 浏览器路径：不硬编码本机用户名，用环境变量与标准安装位置推导
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean)

function findBrowser () {
  for (const p of CANDIDATES) if (existsSync(p)) return p
  return null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForCdp (port, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return await r.json()
    } catch {}
    await sleep(250)
  }
  throw new Error('CDP 未就绪（' + port + '）')
}

class Cdp {
  constructor (wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('ws error')))
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: r, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(msg.error.message)) : r(msg.result)
      } else if (msg.method) {
        this.events.push(msg)
      }
    })
  }

  async send (method, params = {}) {
    await this.ready
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('CDP 超时: ' + method))
        }
      }, 30000)
    })
  }

  close () { try { this.ws.close() } catch {} }
}

async function main () {
  const keep = process.argv.includes('--keep')
  const exe = findBrowser()
  if (!exe) {
    process.stderr.write('未找到可用浏览器\n')
    process.exitCode = 2
    return
  }
  mkdirSync(SHOTS, { recursive: true })
  mkdirSync(PROFILE, { recursive: true })

  // 清掉上次残留的 profile 锁
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(join(PROFILE, f), { force: true }) } catch {}
  }

  const proc = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--allow-file-access-from-files',
    '--window-size=1280,1400',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let stderr = ''
  proc.stderr.on('data', (d) => { stderr += d.toString() })

  const results = []
  const push = (name, ok, detail) => {
    results.push({ name, ok, detail })
    process.stdout.write((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  ' + detail : '') + '\n')
  }

  let cdp = null
  try {
    await waitForCdp(PORT, 20000)

    // 新建标签页指向本地 demo
    const demoUrl = 'file:///' + join(ROOT, 'demo/index.html').replace(/\\/g, '/')
    const created = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(demoUrl)}`, { method: 'PUT' })
    const target = await created.json()
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false })

    // 等报告出现（最多 15s）
    let ready = false
    for (let i = 0; i < 60; i++) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: "!!document.querySelector('#report .verdict')",
        returnByValue: true
      })
      if (r.result.value === true) { ready = true; break }
      await sleep(250)
    }
    push('报告已渲染', ready, ready ? '' : '15s 内未出现 #report .verdict')
    if (!ready) throw new Error('报告未渲染')

    // 判定与关键文本
    const snap = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const q = (s) => document.querySelector(s);
        return {
          verdictClass: q('#report .verdict').className,
          verdictLabel: q('#report .verdict__label').textContent,
          meta: q('#report .verdict__meta').textContent,
          facts: Array.from(document.querySelectorAll('#report .facts dd')).map(e => e.textContent),
          gateIds: Array.from(document.querySelectorAll('#report .finding__head code')).map(e => e.textContent),
          shown: q('#shownVerdict').textContent,
          decoders: q('#decoders').textContent,
          bodyLen: document.body.innerText.length
        };
      })()`,
      returnByValue: true
    })
    const s = snap.result.value
    push('默认参数判定为通过', /verdict--pass/.test(s.verdictClass), s.verdictLabel + ' · ' + s.meta)
    push('双引擎均已加载', /jsQR 已加载 · ZXing 已加载/.test(s.decoders), s.decoders)
    push('报告含几何事实', s.facts.length >= 6, s.facts.join(' / '))
    push('无违规项', s.gateIds.length === 0, 'gates=' + JSON.stringify(s.gateIds))
    push('当前画面判定可读', /read-by-both/.test(s.shown), s.shown)

    // canvas 是否真的画了东西：读像素统计
    const px = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const c = document.querySelector('#preview');
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        const seen = new Set();
        let dark = 0, total = 0, sum = 0;
        for (let i = 0; i < d.length; i += 4) {
          seen.add(d[i] + ',' + d[i+1] + ',' + d[i+2] + ',' + d[i+3]);
          const lum = d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114;
          sum += lum; total++;
          if (lum < 128) dark++;
        }
        return { w: c.width, h: c.height, colors: seen.size, darkRatio: dark/total, meanLum: sum/total };
      })()`,
      returnByValue: true
    })
    const p = px.result.value
    push('canvas 尺寸非零', p.w > 100 && p.h > 100, p.w + '×' + p.h)
    push('canvas 内容非空白', p.colors >= 2 && p.darkRatio > 0.05 && p.darkRatio < 0.9,
      `去重色 ${p.colors}，深色占比 ${(p.darkRatio * 100).toFixed(1)}%，平均亮度 ${p.meanLum.toFixed(0)}`)

    // 切到"静区 0"，验证判定真的会变
    const flip = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const m = document.querySelector('#margin');
        m.value = '0';
        m.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 1200));
        const v = document.querySelector('#report .verdict');
        return { cls: v.className, label: v.querySelector('.verdict__label').textContent,
                 gates: Array.from(document.querySelectorAll('#report .finding__head code')).map(e => e.textContent) };
      })()`,
      awaitPromise: true,
      returnByValue: true
    })
    const f = flip.result.value
    push('静区 0 判为失败', /verdict--fail/.test(f.cls), f.label)
    push('静区 0 报出 quiet-zone', f.gates.includes('quiet-zone'), JSON.stringify(f.gates))

    // console 错误
    const errs = cdp.events
      .filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
      .map(e => e.params.entry ? e.params.entry.text : (e.params.exceptionDetails && e.params.exceptionDetails.text))
    push('无 console 错误', errs.length === 0, errs.slice(0, 3).join(' | '))

    // 截图（整页）
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    const buf = Buffer.from(shot.data, 'base64')
    const file = join(SHOTS, 'demo.png')
    writeFileSync(file, buf)
    const png = PNG.sync.read(buf)
    push('截图落盘且尺寸合理', png.width > 800 && png.height > 800, `${png.width}×${png.height} → ${file}`)

    // 截图本身也要不是白屏（二次确认，避免"截到白图也算 ok"）
    const colors = new Set()
    let dark = 0
    for (let i = 0; i < png.data.length; i += 4) {
      colors.add(png.data[i] + ',' + png.data[i + 1] + ',' + png.data[i + 2])
      if (png.data[i] * 0.299 + png.data[i + 1] * 0.587 + png.data[i + 2] * 0.114 < 128) dark++
    }
    const darkRatio = dark / (png.width * png.height)
    push('截图内容非白屏', colors.size > 20 && darkRatio > 0.01,
      `去重色 ${colors.size}，深色占比 ${(darkRatio * 100).toFixed(2)}%`)
  } catch (e) {
    push('执行未抛异常', false, e.message)
  } finally {
    if (cdp) cdp.close()
    if (!keep) {
      try { proc.kill() } catch {}
      await sleep(300)
    } else {
      process.stdout.write('\n浏览器保持运行（--keep）：http://127.0.0.1:' + PORT + '\n')
    }
  }

  const failed = results.filter(r => !r.ok)
  writeFileSync(join(SHOTS, 'verify.json'), JSON.stringify({
    at: new Date().toISOString(),
    browser: exe,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    stderrTail: stderr.split('\n').slice(-6).join('\n')
  }, null, 2))

  process.stdout.write(`\n${results.length - failed.length}/${results.length} 通过\n`)
  if (failed.length) {
    process.stdout.write('失败项：' + failed.map(f => f.name).join(', ') + '\n')
    process.exitCode = 1
  }
}

main().catch((e) => {
  process.stderr.write((e && e.stack ? e.stack : String(e)) + '\n')
  process.exitCode = 1
})
