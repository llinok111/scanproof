/**
 * 演示页布局探针（不依赖肉眼与截图）
 *
 * 本机 ViewImage 收不到图像，所以"看起来对不对"必须靠可测量的几何与颜色：
 *   1. 每个区块的 bounding rect 是否非零、是否在视口内、是否互相重叠
 *   2. 关键文本的 computed color 与背景色对比度是否达到 WCAG
 *   3. canvas 是否真的画了码（不是纯色块）
 *   4. 是否存在横向溢出（body.scrollWidth > innerWidth）
 *
 * 用法：node scripts/probe-layout.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const PORT = Number(process.env.CDP_PORT || 12033)
const PROFILE = join(ROOT, '.probe/cdp-layout')
const SHOTS = join(ROOT, 'shots/verify')

// 与 verify-demo.mjs 同一份候选列表（不硬编码本机用户名）
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitCdp (port, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) })
      if (r.ok) return true
    } catch {}
    await sleep(250)
  }
  return false
}

class Cdp {
  constructor (wsUrl) {
    this.ws = new WebSocket(wsUrl)
    this.id = 0
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve())
      this.ws.addEventListener('error', () => reject(new Error('ws error')))
    })
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
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
      }, 20000)
    })
  }

  async eval (expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description))
    return r.result.value
  }

  close () { try { this.ws.close() } catch {} }
}

const PROBE = `(() => {
  const out = { viewport: { w: innerWidth, h: innerHeight }, blocks: [], overlaps: [], overflow: null, contrast: [], canvas: null };

  const pick = [
    ['header', 'header'],
    ['参数卡片', '.grid > div:first-child .card'],
    ['预览卡片', '.preview-card'],
    ['报告卡片', '.grid > div:last-child > .card:last-child'],
    ['页脚', 'footer']
  ];
  for (const [name, sel] of pick) {
    const el = document.querySelector(sel);
    if (!el) { out.blocks.push({ name, missing: true }); continue; }
    const r = el.getBoundingClientRect();
    out.blocks.push({ name, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  }

  // 两两重叠检测（只比对可见区块，允许 0 像素相邻）
  const visible = out.blocks.filter(b => !b.missing && b.w > 0 && b.h > 0);
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i], b = visible[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 4 && oy > 4) out.overlaps.push({ a: a.name, b: b.name, ox, oy });
    }
  }

  out.overflow = { scrollW: document.documentElement.scrollWidth, innerW: innerWidth };

  // 对比度：解析 rgb() 计算 WCAG 相对亮度
  const parse = (c) => {
    const m = c.match(/rgba?\\(([^)]+)\\)/);
    if (!m) return null;
    const p = m[1].split(',').map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const L = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.9) return c;
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  for (const sel of ['.sub', 'h1', '.finding__detail', '.verdict__label', 'footer', '.facts dd']) {
    const el = document.querySelector(sel);
    if (!el) { out.contrast.push({ sel, missing: true }); continue; }
    const fg = parse(getComputedStyle(el).color);
    const bg = bgOf(el);
    const r1 = (Math.max(L(fg), L(bg)) + 0.05) / (Math.min(L(fg), L(bg)) + 0.05);
    const size = parseFloat(getComputedStyle(el).fontSize);
    const weight = getComputedStyle(el).fontWeight;
    const isLarge = size >= 24 || (size >= 18.66 && (weight === 'bold' || Number(weight) >= 700));
    out.contrast.push({ sel, ratio: Number(r1.toFixed(2)), size, large: isLarge, need: isLarge ? 3 : 4.5, ok: r1 >= (isLarge ? 3 : 4.5) });
  }

  // canvas：按"模块格"抽样，确认深色块宽度一致（真画了码，不是渐变/纯色）
  const c = document.querySelector('#preview');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const isDark = (x, y) => {
    const i = (y * c.width + x) * 4;
    return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114 < 128;
  };
  // 中间行的游程
  const midY = Math.floor(c.height / 2);
  const runs = [];
  let cur = null;
  for (let x = 0; x < c.width; x++) {
    const dark = isDark(x, midY);
    if (cur && cur.dark === dark) cur.len++;
    else { cur = { dark, len: 1 }; runs.push(cur); }
  }
  out.canvas = {
    w: c.width, h: c.height,
    runs: runs.length,
    runLens: runs.map(r => r.len),
    darkRuns: runs.filter(r => r.dark).length
  };
  return out;
})()`

async function main () {
  const exe = CANDIDATES.find((p) => existsSync(p))
  if (!exe) {
    process.stderr.write('未找到可用浏览器\n')
    process.exitCode = 2
    return
  }
  mkdirSync(SHOTS, { recursive: true })
  mkdirSync(PROFILE, { recursive: true })

  const proc = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--allow-file-access-from-files',
    '--window-size=1280,1400',
    'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'] })

  const results = []
  const push = (name, ok, detail) => {
    results.push({ name, ok, detail })
    process.stdout.write((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  ' + detail : '') + '\n')
  }

  let cdp = null
  try {
    if (!await waitCdp(PORT, 20000)) throw new Error('CDP 未就绪')
    const demoUrl = 'file:///' + join(ROOT, 'demo/index.html').replace(/\\/g, '/')
    const created = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(demoUrl)}`, { method: 'PUT' })
    const target = await created.json()
    cdp = new Cdp(target.webSocketDebuggerUrl)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false })

    // 等报告
    for (let i = 0; i < 60; i++) {
      if (await cdp.eval("!!document.querySelector('#report .verdict')")) break
      await sleep(250)
    }
    await sleep(400)

    // 桌面布局
    const desk = await cdp.eval(PROBE)
    push('无区块缺失', desk.blocks.every(b => !b.missing), JSON.stringify(desk.blocks.filter(b => b.missing)))
    push('所有区块尺寸非零', desk.blocks.every(b => b.w > 40 && b.h >= 16),
      desk.blocks.map(b => `${b.name}:${b.w}×${b.h}`).join(' '))
    push('区块无重叠', desk.overlaps.length === 0, JSON.stringify(desk.overlaps))
    push('无横向溢出', desk.overflow.scrollW <= desk.overflow.innerW + 1,
      `scrollW=${desk.overflow.scrollW} innerW=${desk.overflow.innerW}`)

    const checked = desk.contrast.filter(c => !c.missing)
    const contrastBad = checked.filter(c => !c.ok)
    push('文本对比度达标（WCAG AA）', contrastBad.length === 0 && checked.length >= 4,
      checked.map(c => `${c.sel}=${c.ratio}${c.ok ? '' : '✗'}`).join(' '))

    push('canvas 画出模块化图形', desk.canvas.runs >= 8 && desk.canvas.darkRuns >= 2 && desk.canvas.runLens.every(l => l > 0),
      `游程 ${desk.canvas.runs}（深色 ${desk.canvas.darkRuns}），长度 ${desk.canvas.runLens.join(',')}`)

    // 移动端布局（窄屏不应横向溢出）
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
    await sleep(500)
    const mobile = await cdp.eval(`(() => ({
      scrollW: document.documentElement.scrollWidth,
      innerW: innerWidth,
      canvasW: document.querySelector('#preview').getBoundingClientRect().width,
      reportW: document.querySelector('#report').getBoundingClientRect().width,
      gridCols: getComputedStyle(document.querySelector('.grid')).gridTemplateColumns
    }))()`)
    push('移动端无横向溢出', mobile.scrollW <= mobile.innerW + 1,
      `scrollW=${mobile.scrollW} innerW=${mobile.innerW}，grid=${mobile.gridCols}`)
    push('移动端单列布局生效', !/\s/.test(mobile.gridCols.trim()) || mobile.gridCols.split(' ').length === 1,
      'grid-template-columns=' + mobile.gridCols)

    // 恢复桌面并落一张整页图做归档（不作为判定依据）
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false })
    await sleep(300)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    writeFileSync(join(SHOTS, 'layout-desktop.png'), Buffer.from(shot.data, 'base64'))
    push('桌面截图归档', true, join(SHOTS, 'layout-desktop.png'))
  } catch (e) {
    push('执行未抛异常', false, e.message)
  } finally {
    if (cdp) cdp.close()
    try { proc.kill() } catch {}
  }

  const failed = results.filter(r => !r.ok)
  writeFileSync(join(SHOTS, 'layout.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2))
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
