'use strict'

/**
 * 解码集成层
 *
 * 两个独立实现的解码器各自给出结论：
 *   - jsQR（zapatarious/jsQR 血统，纯 JS，Apache-2.0）
 *   - @zxing/library（ZXing 的 TS 移植，Apache-2.0）
 *
 * 两个都是**可选依赖**：装不上时报告里标 unavailable，绝不把"没测"说成"通过"。
 */

const unavailableReason = { jsqr: null, zxing: null }

let jsQR = null
let zxing = null
let zxingReader = null

/**
 * zxing 在"找不到码"时会用 console.warn 打整段堆栈（它把 NotFoundException 当异常路径）。
 * 这不是我们的错误，但会淹没正常输出，所以加载时静音这一类日志，并在 dispose 时还原。
 */
const ZXING_LOG_PREFIXES = ['MultiFormatReader:', 'NotFoundException:', 'ChecksumException:', 'FormatException:', 'IllegalArgumentException:']

function silenceZxingNoise () {
  const original = console.warn
  console.warn = function () {
    const first = arguments[0]
    if (typeof first === 'string') {
      for (const p of ZXING_LOG_PREFIXES) if (first.startsWith(p)) return
    }
    return original.apply(console, arguments)
  }
  return () => { console.warn = original }
}

function loadJsQR () {
  if (jsQR === false) return null
  if (jsQR) return jsQR
  try {
    // eslint-disable-next-line global-require
    jsQR = require('jsqr')
    return jsQR
  } catch (e) {
    // 可选依赖装不上：记录原因但不抛出，让报告能标 unavailable
    jsQR = false
    unavailableReason.jsqr = e.message
    return null
  }
}

function loadZxing () {
  if (zxing === false) return null
  if (zxing) return zxing
  try {
    // eslint-disable-next-line global-require
    zxing = require('@zxing/library')
    return zxing
  } catch (e) {
    zxing = false
    unavailableReason.zxing = e.message
    return null
  }
}

/**
 * 复用同一个 reader：构造 MultiFormatReader + setHints 在变体扫描里会被调用几十次，
 * 每次重建要重新分配 Map 与 hints，实测占单次解码开销的显著比例。
 */
function getZxingReader () {
  const zx = loadZxing()
  if (!zx) return { zx: null, reader: null }
  if (!zxingReader) {
    zxingReader = new zx.MultiFormatReader()
    const hints = new Map()
    hints.set(zx.DecodeHintType.POSSIBLE_FORMATS, [zx.BarcodeFormat.QR_CODE])
    hints.set(zx.DecodeHintType.TRY_HARDER, true)
    zxingReader.setHints(hints)
    // 必须在 setHints 之后：zxing 只在 decode 时读取这些 class 字段
    zxingReader.MAX_IMAGE_SIZE = 0
  }
  return { zx, reader: zxingReader }
}

function available () {
  return { jsqr: !!loadJsQR(), zxing: !!loadZxing() }
}

function toLuminance (rgba, w, h) {
  const out = new Uint8ClampedArray(w * h)
  for (let i = 0; i < w * h; i++) {
    out[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0
  }
  return out
}

/**
 * 用 jsQR 解码
 * @returns {{status:'read'|'no-read'|'unavailable', text?:string}}
 */
function decodeWithJsQR (rgba, width, height, opts) {
  const fn = loadJsQR()
  if (!fn) return { status: 'unavailable', decoder: 'jsqr' }
  const inversionAttempts = (opts && opts.inversionAttempts) || 'dontInvert'
  let res
  try {
    res = fn(new Uint8ClampedArray(rgba), width, height, { inversionAttempts })
  } catch (e) {
    return { status: 'error', decoder: 'jsqr', message: e.message }
  }
  if (!res) return { status: 'no-read', decoder: 'jsqr' }
  return { status: 'read', decoder: 'jsqr', text: res.data, version: res.version }
}

/**
 * 用 zxing 解码
 * @returns {{status:'read'|'no-read'|'unavailable', text?:string}}
 */
function decodeWithZxing (rgba, width, height, opts) {
  const pair = getZxingReader()
  if (!pair.zx) return { status: 'unavailable', decoder: 'zxing' }
  const { zx, reader } = pair
  const lum = toLuminance(rgba, width, height)
  const source = new zx.RGBLuminanceSource(lum, width, height)
  const bitmap = new zx.BinaryBitmap(new zx.HybridBinarizer(source))
  try {
    const result = reader.decode(bitmap)
    return { status: 'read', decoder: 'zxing', text: result.getText() }
  } catch (e) {
    // zxing 用异常表达"找不到码"，这是正常控制流，不是错误
    return { status: 'no-read', decoder: 'zxing' }
  } finally {
    reader.reset()
  }
}

/**
 * 双引擎解码 + 与期望值比对
 * @param {Uint8ClampedArray} rgba
 * @param {Number} width
 * @param {Number} height
 * @param {String} [expected] 期望原文；省略则只报告是否读出
 * @returns {Object} per-engine 结论 + 汇总状态
 */
/**
 * 双引擎解码 + 与期望值比对
 * @param {Uint8ClampedArray} rgba
 * @param {Number} width
 * @param {Number} height
 * @param {String} [expected] 期望原文；省略则只报告是否读出
 * @returns {Object} per-engine 结论 + 汇总状态
 */
function decodeBoth (rgba, width, height, expected, opts) {
  // 参数校验：尺寸缺失时两个解码器会各自"读不出"，把调用方的 bug 伪装成产物的问题。
  // 必须在这里大声失败，而不是让结论静默变差。
  if (!rgba || typeof rgba.length !== 'number') {
    throw new TypeError('decodeBoth: rgba 必须是像素数组（Uint8ClampedArray / Buffer）')
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError(`decodeBoth: 尺寸非法（width=${width}, height=${height}）；` +
      '若这是退化变换的输出，请检查变换是否返回了 height')
  }
  if (rgba.length < width * height * 4) {
    throw new RangeError(`decodeBoth: 像素数据不足（需要 ${width * height * 4} 字节，实得 ${rgba.length}）`)
  }

  const a = decodeWithJsQR(rgba, width, height, opts)
  const b = decodeWithZxing(rgba, width, height, opts)

  const judge = (r) => {
    if (r.status === 'unavailable') return 'unavailable'
    if (r.status === 'error') return 'error'
    if (r.status !== 'read') return 'no-read'
    if (expected === undefined || expected === null) return 'read'
    return r.text === expected ? 'read' : 'wrong-payload'
  }

  const ja = judge(a)
  const jb = judge(b)

  let consensus
  if (ja === 'unavailable' && jb === 'unavailable') consensus = 'unavailable'
  else if (ja === 'error' && jb === 'error') consensus = 'error'
  else if (ja === 'read' && jb === 'read') consensus = 'read-by-both'
  else if (ja === 'read' || jb === 'read') consensus = 'read-by-one'
  else if (ja === 'wrong-payload' || jb === 'wrong-payload') consensus = 'wrong-payload'
  else consensus = 'no-read-by-any'

  return {
    consensus,
    decoders: {
      jsqr: Object.assign({}, a, { verdict: ja }),
      zxing: Object.assign({}, b, { verdict: jb })
    }
  }
}

module.exports = {
  available,
  unavailableReason: () => Object.assign({}, unavailableReason),
  decodeBoth,
  decodeWithJsQR,
  decodeWithZxing,
  toLuminance,
  silenceZxingNoise
}
