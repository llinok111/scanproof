'use strict'

/**
 * 浏览器演示入口
 *
 * 只做三件事：
 *   1. 把参数交给 scanproof，拿到与 CLI 完全一致的报告
 *   2. 把同一个 RGBA 矩阵画到 canvas 上（不重新渲染，保证"看到的就是测到的"）
 *   3. 允许叠加一层退化变换，让人肉眼看到"变糊/变小/反光"时判定怎么变
 *
 * 刻意不做的：不做在线生成图床、不上传任何文本。所有计算都在本地。
 */

const { audit } = require('../lib/scanproof/report')
const { renderRGBA } = require('../lib/scanproof/geometry')
const { VARIANTS } = require('../lib/scanproof/variants')
const decoder = require('../lib/scanproof/decoder')

const el = (id) => document.getElementById(id)

const state = {
  text: 'https://example.com/order/12345',
  options: { errorCorrectionLevel: 'M', margin: 4, scale: 4 },
  variantId: 'none',
  report: null,
  base: null,
  shown: null
}

const VERDICT_LABEL = { pass: '通过', warn: '警告', fail: '失败', inconclusive: '未验证' }

function readForm () {
  const opts = {
    errorCorrectionLevel: el('ec').value,
    margin: Number(el('margin').value),
    scale: Number(el('scale').value)
  }
  const dark = el('dark').value.trim()
  const light = el('light').value.trim()
  if (dark || light) {
    opts.color = {}
    if (dark) opts.color.dark = normalizeHex(dark)
    if (light) opts.color.light = normalizeHex(light)
  }
  return opts
}

/** 上游 hex2rgba 只接受 #RGB / #RRGGBB / #RGBA / #RRGGBBAA；这里把 6 位补成 8 位 */
function normalizeHex (hex) {
  let h = hex.replace(/^#/, '')
  if (h.length === 3) h = h.split('').map(c => c + c).join('') + 'FF'
  else if (h.length === 4) h = h.split('').map(c => c + c).join('')
  else if (h.length === 6) h += 'FF'
  return '#' + h.toUpperCase()
}

function draw (rgba, width) {
  const canvas = el('preview')
  const dpr = Math.min(2, window.devicePixelRatio || 1)
  const box = 320
  const px = Math.max(1, Math.floor(box / width))
  canvas.width = width * px * dpr
  canvas.height = width * px * dpr
  canvas.style.width = width * px + 'px'
  canvas.style.height = width * px + 'px'
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(width, width)
  img.data.set(rgba)
  const off = document.createElement('canvas')
  off.width = width
  off.height = width
  off.getContext('2d').putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height)
}

function chip (verdict) {
  const cls = 'chip chip--' + verdict
  return '<span class="' + cls + '">' + (VERDICT_LABEL[verdict] || verdict) + '</span>'
}

function renderReport (rep) {
  const box = el('report')
  const rows = rep.gates.map(function (g) {
    return '<li class="finding finding--' + g.severity + '">' +
      '<div class="finding__head"><code>' + g.id + '</code><span class="finding__sev">' + g.severity + '</span></div>' +
      '<div class="finding__title">' + escapeHtml(g.title) + '</div>' +
      (g.ref ? '<div class="finding__ref">依据：' + escapeHtml(g.ref) + '</div>' : '') +
      '<div class="finding__detail">' + escapeHtml(g.detail) + '</div>' +
      (g.fix ? '<div class="finding__fix">建议：' + escapeHtml(g.fix) + '</div>' : '') +
      '</li>'
  }).join('')

  const variants = rep.variants.map(function (v) {
    const d = v.decoders || {}
    return '<tr><td>' + escapeHtml(v.label) + (v.optional ? ' <span class="muted">（边界）</span>' : '') + '</td>' +
      '<td class="num">' + v.size + '</td>' +
      '<td class="num">' + (d.jsqr || v.verdict) + '</td>' +
      '<td class="num">' + (d.zxing || v.verdict) + '</td>' +
      '<td>' + chip(v.verdict === 'read-by-both' ? 'pass' : v.verdict === 'read-by-one' ? 'warn' : v.verdict === 'no-read-by-any' ? 'fail' : 'inconclusive') + '</td></tr>'
  }).join('')

  box.innerHTML =
    '<div class="verdict verdict--' + rep.verdict + '">' +
      '<span class="verdict__label">' + (VERDICT_LABEL[rep.verdict] || rep.verdict) + '</span>' +
      '<span class="verdict__meta">' + rep.decode.consensus + ' · v' + rep.geometry.version + ' / ' + rep.geometry.errorCorrectionLevel +
      ' · ' + rep.geometry.modulesPerSide + ' 模块 · ' + rep.geometry.pixels + 'px</span>' +
    '</div>' +
    '<dl class="facts">' +
      '<div><dt>单模块</dt><dd>' + fmt(rep.geometry.modulePx) + ' px' + (rep.geometry.integerScale ? '' : '（非整数）') + '</dd></div>' +
      '<div><dt>静区</dt><dd>' + rep.geometry.quietZoneModules + ' 模块 / ' + fmt(rep.geometry.quietZonePx) + ' px</dd></div>' +
      '<div><dt>对比度</dt><dd>' + rep.contrast + ':1</dd></div>' +
      '<div><dt>极性</dt><dd>' + rep.geometry.polarity + '</dd></div>' +
      '<div><dt>jsQR</dt><dd>' + rep.decode.decoders.jsqr.verdict + '</dd></div>' +
      '<div><dt>ZXing</dt><dd>' + rep.decode.decoders.zxing.verdict + '</dd></div>' +
    '</dl>' +
    (rep.gates.length
      ? '<ul class="findings">' + rows + '</ul>'
      : '<p class="empty">没有发现违规项。</p>') +
    (rep.warnings.length ? '<ul class="notes">' + rep.warnings.map(w => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul>' : '') +
    '<details class="variants"><summary>劣化场景（' + rep.variants.length + '）</summary>' +
      '<table><thead><tr><th>场景</th><th>尺寸</th><th>jsQR</th><th>ZXing</th><th>结论</th></tr></thead><tbody>' +
      variants + '</tbody></table></details>'
}

function fmt (n) {
  if (typeof n !== 'number' || !isFinite(n)) return String(n)
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function escapeHtml (s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  })
}

function applyVariant () {
  const base = state.base
  if (!base) return
  if (state.variantId === 'none') {
    state.shown = { rgba: base.rgba, width: base.width, height: base.height }
  } else {
    const v = VARIANTS.filter(x => x.id === state.variantId)[0]
    state.shown = v ? v.apply(base) : { rgba: base.rgba, width: base.width, height: base.height }
  }
  draw(state.shown.rgba, state.shown.width)
  updateShownVerdict()
}

function updateShownVerdict () {
  const target = el('shownVerdict')
  if (!state.shown || !state.report) { target.textContent = ''; return }
  const av = decoder.available()
  if (!av.jsqr && !av.zxing) {
    target.textContent = '解码器不可用'
    return
  }
  const res = decoder.decodeBoth(state.shown.rgba, state.shown.width, state.shown.height, state.text)
  target.textContent = '当前画面：' + res.consensus
  target.className = 'shown ' + (res.consensus === 'read-by-both' ? 'shown--pass' : res.consensus === 'read-by-one' ? 'shown--warn' : 'shown--fail')
}

async function run () {
  const btn = el('run')
  btn.disabled = true
  btn.textContent = '验收中…'
  try {
    state.text = el('text').value
    state.options = readForm()
    state.base = renderRGBA(state.text, state.options)
    const rep = await audit(state.text, state.options, {})
    state.report = rep
    renderReport(rep)
    applyVariant()
    el('error').textContent = ''
  } catch (e) {
    el('error').textContent = '无法生成：' + e.message
  } finally {
    btn.disabled = false
    btn.textContent = '运行验收'
  }
}

function bind () {
  el('run').addEventListener('click', run)
  el('text').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') run()
  })
  const variantSel = el('variant')
  VARIANTS.forEach(function (v) {
    const o = document.createElement('option')
    o.value = v.id
    o.textContent = v.label
    variantSel.appendChild(o)
  })
  variantSel.addEventListener('change', function () {
    state.variantId = variantSel.value
    applyVariant()
  })
  // 参数变化不自动跑（验收有成本），但退化预览要立即响应
  ;['ec', 'margin', 'scale', 'dark', 'light'].forEach(function (id) {
    el(id).addEventListener('change', run)
  })
  const av = decoder.available()
  el('decoders').textContent = 'jsQR ' + (av.jsqr ? '已加载' : '未加载') + ' · ZXing ' + (av.zxing ? '已加载' : '未加载')
}

bind()
run()
