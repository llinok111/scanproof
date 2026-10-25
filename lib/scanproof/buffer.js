'use strict'

/**
 * 对"已经生成好的图片文件"做验收
 *
 * 场景：二维码是设计稿导出的、是别人给的、是从 CDN 拉下来的——
 * 这时没有原文参数，只能从像素出发判断。
 *
 * 能力边界（必须说清）：
 *   - 静区 / 模块像素 / 极性 / 对比度：可以从像素判断
 *   - 规范闸门（纠错等级、版本）：无法从像素反推 → 标 unknown，不猜
 */

const fs = require('fs')
const path = require('path')
const decoder = require('./decoder')
const S = require('./geometry')

function loadPNG (file) {
  let PNG
  try {
    // eslint-disable-next-line global-require
    PNG = require('pngjs').PNG
  } catch (e) {
    return { error: 'pngjs 不可用：无法读取图片文件（npm i pngjs）' }
  }
  let buf
  try {
    buf = fs.readFileSync(path.resolve(file))
  } catch (e) {
    return { error: '读取文件失败：' + e.message }
  }
  try {
    const png = PNG.sync.read(buf)
    // pngjs 输出为 RGBA
    return { width: png.width, height: png.height, rgba: new Uint8ClampedArray(png.data), bytes: buf.length }
  } catch (e) {
    return { error: '不是可解析的 PNG：' + e.message }
  }
}

/** 兜底：版本未知时用"中间一行第一个深色像素"粗估静区 */
function inferFirstDark (rgba, w, h) {
  const y = Math.floor(h / 2)
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    const lum = S.luminance(rgba[i], rgba[i + 1], rgba[i + 2])
    if (rgba[i + 3] > 8 && lum < 128) return x
  }
  return null
}

/**
 * 由像素统计推断静区模块数。
 *
 * 不能直接用"中间一行的首个深色像素"：若该行第一个模块恰好是浅色，会把静区读大。
 * 正确做法是先由解码器给出的版本得到模块数 m，再用静区的四个方向统计"整段都是背景色"的厚度。
 */
function inferQuietZoneModules (rgba, w, h, modulesPerSide) {
  if (!modulesPerSide) return 0
  const bg = sampleBackground(rgba, w, h)
  const bgPixel = { r: bg[0], g: bg[1], b: bg[2] }
  const rowFullyQuiet = (y) => {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (rgba[i + 3] > 8 && !isClose(rgba, i, [bgPixel], 24)) return false
    }
    return true
  }
  const colFullyQuiet = (x) => {
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4
      if (rgba[i + 3] > 8 && !isClose(rgba, i, [bgPixel], 24)) return false
    }
    return true
  }
  let top = 0
  while (top < h && rowFullyQuiet(top)) top++
  let left = 0
  while (left < w && colFullyQuiet(left)) left++
  let bottom = 0
  while (bottom < h - top && rowFullyQuiet(h - 1 - bottom)) bottom++
  let right = 0
  while (right < w - left && colFullyQuiet(w - 1 - right)) right++

  // 四条边取中位数：单边可能被定位图案的偶然对齐影响
  const pad = [top, bottom, left, right].sort((a, b) => a - b)
  const padPx = (pad[1] + pad[2]) / 2
  if (padPx <= 0) return 0
  const symbolPx = w - 2 * padPx
  if (symbolPx <= 0) return null
  return padPx / (symbolPx / modulesPerSide)
}

function sampleBackground (rgba, w, h) {
  // 静区是"围绕符号的一圈背景"，因此背景色应取四条边的中位色，
  // 而不是四角——无静区的图四角恰好落在定位图案的黑色模块上。
  const samples = []
  const push = (x, y) => {
    const i = (y * w + x) * 4
    samples.push([rgba[i], rgba[i + 1], rgba[i + 2]])
  }
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1) }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y) }
  return [0, 1, 2].map((c) => {
    const arr = samples.map(s => s[c]).sort((a, b) => a - b)
    return arr[Math.floor(arr.length / 2)]
  })
}

function isClose (rgba, i, bgList, tol) {
  for (const c of bgList) {
    if (Math.abs(rgba[i] - c.r) <= tol && Math.abs(rgba[i + 1] - c.g) <= tol && Math.abs(rgba[i + 2] - c.b) <= tol) return true
  }
  return false
}
async function auditBuffer (file) {
  const img = loadPNG(file)
  if (img.error) {
    return { schema: 'scanproof/buffer@1', file: path.resolve(file), verdict: 'fail', error: img.error, gates: [] }
  }

  const { rgba, width, height } = img
  const av = decoder.available()
  const decode = (av.jsqr || av.zxing)
    ? decoder.decodeBoth(rgba, width, height, null)
    : { consensus: 'unavailable', decoders: { jsqr: { verdict: 'unavailable' }, zxing: { verdict: 'unavailable' } } }

  const gates = []
  const payload = decode.decoders.jsqr.text || decode.decoders.zxing.text || null
  const version = decode.decoders.jsqr.version || null
  const modulesPerSide = version ? 17 + 4 * version : null
  const quietZoneModules = inferQuietZoneModules(rgba, width, height, modulesPerSide)
  const quietPx = quietZoneModules !== null && modulesPerSide
    ? Math.round(quietZoneModules * (width / (modulesPerSide + 2 * quietZoneModules)))
    : inferFirstDark(rgba, width, height)

  const geometry = {
    pixels: width,
    height,
    quietZonePx: quietPx,
    modulesPerSide,
    modulePx: modulesPerSide && quietPx !== null ? (width - 2 * quietPx) / modulesPerSide : null,
    quietZoneModules
  }

  if (quietPx === null) {
    gates.push({ id: 'no-symbol', severity: 'error', title: '没有找到深色模块', ref: '', detail: '整张图都是背景色', fix: '检查导出参数' })
  } else if (geometry.quietZoneModules !== null && geometry.quietZoneModules < 3.5) {
    gates.push({
      id: 'quiet-zone',
      severity: 'error',
      title: '静区不足 4 模块',
      ref: 'ISO/IEC 18004:2015 §6.3.8',
      detail: `由像素反推静区约 ${geometry.quietZoneModules.toFixed(2)} 模块`,
      fix: '在容器上补足 4 模块留白'
    })
  }

  if (geometry.modulePx !== null && geometry.modulePx < 2) {
    gates.push({
      id: 'module-pixels',
      severity: 'warning',
      title: '模块像素过小',
      ref: '经验下限',
      detail: `由像素反推每模块约 ${geometry.modulePx.toFixed(2)} px`,
      fix: '重新以更大尺寸导出'
    })
  }

  if (decode.consensus === 'no-read-by-any') {
    gates.push({ id: 'decode', severity: 'error', title: '双解码器均读不出', ref: '', detail: '产物在两种独立解码器下都无法读出', fix: '按 docs/LIMITS.md 中的清单逐项排查' })
  } else if (decode.consensus === 'read-by-one') {
    gates.push({ id: 'decode', severity: 'warning', title: '仅单个解码器可读', ref: '', detail: '存在兼容性风险', fix: '' })
  }

  const verdict = gates.some(g => g.severity === 'error')
    ? 'fail'
    : decode.consensus === 'unavailable'
      ? 'inconclusive'
      : gates.length ? 'warn' : 'pass'

  return {
    schema: 'scanproof/buffer@1',
    file: path.resolve(file),
    bytes: img.bytes,
    geometry,
    decode,
    payload,
    gates,
    summary: summarize(gates),
    verdict,
    unknown: ['errorCorrectionLevel（需有原文参数才能确定）', 'margin 的原始设置值（已由像素反推，误差 ±0.5 模块）']
  }
}

function summarize (gates) {
  const by = { error: 0, warning: 0, info: 0 }
  for (const g of gates) by[g.severity] = (by[g.severity] || 0) + 1
  return by
}

module.exports = { auditBuffer }
