'use strict'

/**
 * ScanProof —— QRCode 产物可扫性验收层
 *
 * 上游 node-qrcode 只负责"生成"。本模块负责回答一个上游不回答的问题：
 *   "这份产物，真的扫得出来吗？"
 *
 * 设计约束：
 * 1. 零侵入：不修改 lib/ 下任何上游文件，不改变任何默认行为。
 * 2. 双解码器：单引擎的"失败"不等于不可扫，必须给两个独立解码器各自的结论。
 * 3. 可复现：同一输入必须得到同一报告（矩阵由规范确定性导出）。
 * 4. 诚实：无法测量的项标 unavailable，不折成通过。
 */

const QRCode = require('../core/qrcode')
const Utils = require('../renderer/utils')

// 规范常量
const QUIET_ZONE_MODULES = 4 // ISO/IEC 18004:2015 §6.3.8
const MIN_MODULE_PIXELS = 2 // 经验下限：模块 < 2 px 时采样不确定性过高
const MAX_MODULE_PIXELS = 20 // 上限只用于提示"体积浪费"

/**
 * 计算二维码符号的几何信息（与渲染器同一套算法，保证"报告的就是画出来的"）
 */
function geometry (text, options) {
  const opts = Utils.getOptions(options || {})
  const qr = QRCode.create(text, options || {})
  const modulesPerSide = qr.modules.size
  const scale = Utils.getScale(modulesPerSide, opts)
  const pixels = Utils.getImageWidth(modulesPerSide, opts)
  const quietZonePx = opts.margin * scale
  const modulePx = scale
  const totalModules = modulesPerSide + opts.margin * 2

  return {
    version: qr.version,
    errorCorrectionLevel: errorCorrectionLevelName(qr.errorCorrectionLevel),
    modulesPerSide,
    marginModules: opts.margin,
    scale,
    modulePx,
    pixels,
    totalModules,
    quietZonePx,
    integerScale: Math.abs(scale - Math.round(scale)) < 1e-9,
    quietZoneModules: opts.margin,
    // 极性：深色模块在浅色底上 = normal；反之 inverted
    polarity: relativeLuminanceLinear(opts.color.dark.r, opts.color.dark.g, opts.color.dark.b) <
      relativeLuminanceLinear(opts.color.light.r, opts.color.light.g, opts.color.light.b)
      ? 'normal'
      : 'inverted',
    color: { dark: opts.color.dark.hex, light: opts.color.light.hex, darkAlpha: opts.color.dark.a, lightAlpha: opts.color.light.a },
    // 供闸门做像素级判定：把调色板原样带出，避免闸门自己去 parse 十六进制
    palette: {
      dark: { r: opts.color.dark.r, g: opts.color.dark.g, b: opts.color.dark.b, a: opts.color.dark.a },
      light: { r: opts.color.light.r, g: opts.color.light.g, b: opts.color.light.b, a: opts.color.light.a }
    }
  }
}

function errorCorrectionLevelName (level) {
  const map = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' }
  return map[level.bit] !== undefined ? map[level.bit] : 'M'
}

/**
 * 渲染为 RGBA 像素（与 PNG 渲染器同源的算法，但纯内存、无 I/O、可断言）
 */
function renderRGBA (text, options) {
  const opts = Utils.getOptions(Object.assign({}, options))
  const qr = QRCode.create(text, Object.assign({}, options))
  const size = qr.modules.size
  const total = Utils.getImageWidth(size, opts)
  const data = new Uint8ClampedArray(total * total * 4)
  Utils.qrToImageData(data, qr, opts)
  return { width: total, height: total, rgba: data, qr }
}

function luminance (r, g, b) {
  // ITU-R BT.601 亮度（与 zxing 的 RGBLuminanceSource 同口径，便于结果互证）
  return (r * 0.299 + g * 0.587 + b * 0.114)
}

function relativeLuminanceLinear (r, g, b) {
  // WCAG 2.x 相对亮度：用于对比度判定
  const f = (c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/**
 * 单色相对亮度（WCAG 口径），供闸门做极性判断
 * @param {String} hex
 * @returns {Number}
 */
function relativeLuminanceForGate (hex) {
  const c = Utils.getOptions({ color: { dark: hex } }).color.dark
  return relativeLuminanceLinear(c.r, c.g, c.b)
}

function contrastRatio (darkHex, lightHex) {
  const d = Utils.getOptions({ color: { dark: darkHex, light: lightHex } }).color
  const Ld = relativeLuminanceLinear(d.dark.r, d.dark.g, d.dark.b)
  const Ll = relativeLuminanceLinear(d.light.r, d.light.g, d.light.b)
  const hi = Math.max(Ld, Ll)
  const lo = Math.min(Ld, Ll)
  return (hi + 0.05) / (lo + 0.05)
}

module.exports = {
  QUIET_ZONE_MODULES,
  MIN_MODULE_PIXELS,
  MAX_MODULE_PIXELS,
  geometry,
  renderRGBA,
  luminance,
  relativeLuminanceForGate,
  contrastRatio,
  errorCorrectionLevelName
}
