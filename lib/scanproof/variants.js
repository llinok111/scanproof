'use strict'

/**
 * 变体扫描（robustness variants）
 *
 * 目的：把"在我显示器上能扫"升级成"在若干可复现的劣化条件下仍能扫"。
 * 每个变体是**像素级、确定性的**变换，不依赖 GPU、不依赖随机数，
 * 因此同一产物在任何机器上都得到同一结论。
 *
 * 变换只用纯 JS 实现（不引入 sharp / canvas 这类原生依赖），
 * 这样报告可以在任何装了 Node 的机器上复现。
 */

const decoder = require('./decoder')

/** 最近邻降采样（模拟屏幕缩小 / 印刷精度不足） */
function downscale (rgba, w, h, factor) {
  const nw = Math.max(1, Math.floor(w / factor))
  const nh = Math.max(1, Math.floor(h / factor))
  const out = new Uint8ClampedArray(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(w - 1, Math.floor((x + 0.5) * w / nw))
      const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / nh))
      const si = (sy * w + sx) * 4
      const di = (y * nw + x) * 4
      out[di] = rgba[si]
      out[di + 1] = rgba[si + 1]
      out[di + 2] = rgba[si + 2]
      out[di + 3] = rgba[si + 3]
    }
  }
  return { rgba: out, width: nw, height: nh }
}

/** 可分离盒式模糊（两次 pass 近似高斯），radius 为整数像素 */
function boxBlur (rgba, w, h, radius) {
  if (radius < 1) return { rgba, width: w, height: h }
  const tmp = new Uint8ClampedArray(rgba.length)
  const out = new Uint8ClampedArray(rgba.length)
  const k = radius * 2 + 1

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0
      for (let d = -radius; d <= radius; d++) {
        const xx = Math.min(w - 1, Math.max(0, x + d))
        const i = (y * w + xx) * 4
        r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]
      }
      const o = (y * w + x) * 4
      tmp[o] = r / k; tmp[o + 1] = g / k; tmp[o + 2] = b / k; tmp[o + 3] = a / k
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0
      for (let d = -radius; d <= radius; d++) {
        const yy = Math.min(h - 1, Math.max(0, y + d))
        const i = (yy * w + x) * 4
        r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2]; a += tmp[i + 3]
      }
      const o = (y * w + x) * 4
      out[o] = r / k; out[o + 1] = g / k; out[o + 2] = b / k; out[o + 3] = a / k
    }
  }
  return { rgba: out, width: w, height: h }
}

/** 线性亮度/对比变换：out = in * gain + offset，模拟印刷偏色与背光不足 */
function linear (rgba, w, h, gain, offset) {
  const out = new Uint8ClampedArray(rgba.length)
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i] * gain + offset
    out[i + 1] = rgba[i + 1] * gain + offset
    out[i + 2] = rgba[i + 2] * gain + offset
    out[i + 3] = rgba[i + 3]
  }
  return { rgba: out, width: w, height: h }
}

/** 叠加镜头高光（镜面反光）：一个圆形区域的像素被拉向白色 */
function glare (rgba, w, h, spec) {
  const out = new Uint8ClampedArray(rgba)
  const cx = w * spec.cx
  const cy = h * spec.cy
  const r = Math.min(w, h) * spec.radius
  const strength = spec.strength
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d > r) continue
      const t = (1 - d / r) * strength
      const i = (y * w + x) * 4
      out[i] = rgba[i] * (1 - t) + 255 * t
      out[i + 1] = rgba[i + 1] * (1 - t) + 255 * t
      out[i + 2] = rgba[i + 2] * (1 - t) + 255 * t
    }
  }
  return { rgba: out, width: w, height: h }
}

/** 中值噪声（模拟印刷网点 / 传感器噪点），确定性伪随机 */
function saltPepper (rgba, w, h, ratio) {
  const out = new Uint8ClampedArray(rgba)
  let seed = 0x9e3779b9
  const next = () => {
    seed ^= seed << 13; seed >>>= 0
    seed ^= seed >> 17
    seed ^= seed << 5; seed >>>= 0
    return seed / 0xffffffff
  }
  const total = w * h
  const count = Math.floor(total * ratio)
  for (let n = 0; n < count; n++) {
    const p = Math.floor(next() * total)
    const v = next() < 0.5 ? 0 : 255
    const i = p * 4
    out[i] = out[i + 1] = out[i + 2] = v
  }
  return { rgba: out, width: w, height: h }
}

/** 最近邻旋转（模拟拍摄角度），输出为覆盖整个旋转后包围盒、背景填白 */
function rotate (rgba, w, h, degrees, background) {
  const rad = degrees * Math.PI / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const nw = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin))
  const nh = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos))
  const out = new Uint8ClampedArray(nw * nh * 4)
  const bg = background || [255, 255, 255, 255]
  for (let i = 0; i < out.length; i += 4) {
    out[i] = bg[0]; out[i + 1] = bg[1]; out[i + 2] = bg[2]; out[i + 3] = bg[3]
  }
  const cx = w / 2
  const cy = h / 2
  const ncx = nw / 2
  const ncy = nh / 2
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const dx = x - ncx
      const dy = y - ncy
      const sx = Math.round(dx * cos + dy * sin + cx)
      const sy = Math.round(-dx * sin + dy * cos + cy)
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
      const si = (sy * w + sx) * 4
      const di = (y * nw + x) * 4
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3]
    }
  }
  return { rgba: out, width: nw, height: nh }
}

/**
 * 变体目录。
 * 阈值来自实测（docs/EVIDENCE.md），不是拍脑袋：
 * 所有阈值都设在"默认参数下的 148px 产物仍可读"与"明显过界"之间。
 */
const VARIANTS = [
  {
    id: 'downscale-2x',
    label: '分辨率减半（屏幕缩小显示）',
    apply: (r) => downscale(r.rgba, r.width, r.height, 2)
  },
  {
    id: 'downscale-3x',
    // 边界场景：148px 基础图降到 49px 时双读失败，但 200px/296px 基础图降到 1/3 仍通过。
    // 因此它衡量的是绝对尺寸够不够，不是缩放比对不对。
    label: '分辨率降到 1/3（绝对尺寸随基础图变化）',
    optional: true,
    apply: (r) => downscale(r.rgba, r.width, r.height, 3)
  },
  {
    id: 'blur-1px',
    label: '1px 盒式模糊（轻微失焦）',
    apply: (r) => boxBlur(r.rgba, r.width, r.height, 1)
  },
  {
    id: 'rotate-5deg',
    label: '旋转 5°',
    apply: (r) => rotate(r.rgba, r.width, r.height, 5)
  },
  {
    id: 'rotate-15deg',
    label: '旋转 15°',
    apply: (r) => rotate(r.rgba, r.width, r.height, 15)
  },
  {
    id: 'low-light',
    label: '低照度（亮度 ×0.55，叠加 10 噪点）',
    apply: (r) => linear(r.rgba, r.width, r.height, 0.55, 110)
  },
  {
    id: 'glare',
    // 位置压在左上定位图案上（最坏情况）。实测：居中 0.5R 的全强度高光双读仍通过，
    // 只有盖住定位图案时才双读失败；作为边界场景保留，不作为缺陷证据。
    label: '镜面高光（覆盖左上定位图案，强度 1.0）',
    optional: true,
    apply: (r) => glare(r.rgba, r.width, r.height, { cx: 0.25, cy: 0.25, radius: 0.4, strength: 1 })
  },
  {
    id: 'speckle',
    // 阈值 1%：实测 0.5% / 1% 仍双读，2% 双读失败（docs/EVIDENCE.md 实验 G3）
    label: '印刷噪点（1% 像素被置黑/白）',
    apply: (r) => saltPepper(r.rgba, r.width, r.height, 0.01)
  }
]

async function runVariants (text, qrOptions, opts) {
  const S = require('./geometry')
  const enabled = !opts || opts.enabled !== false
  const ids = opts && opts.ids
  const base = S.renderRGBA(text, qrOptions)
  const results = []

  for (const v of VARIANTS) {
    if (ids && ids.indexOf(v.id) === -1) continue
    const t0 = Date.now()
    const img = v.apply(base)
    const record = {
      id: v.id,
      label: v.label,
      optional: !!v.optional,
      size: img.width + 'x' + img.height,
      enabled: enabled && decoder.available().jsqr !== false
    }
    if (!enabled) {
      record.verdict = 'unavailable'
      record.detail = '解码器不可用，变体未验证'
    } else {
      const res = decoder.decodeBoth(img.rgba, img.width, img.height, text)
      record.verdict = res.consensus
      record.decoders = {
        jsqr: res.decoders.jsqr.verdict,
        zxing: res.decoders.zxing.verdict
      }
      if (res.consensus !== 'read-by-both') {
        record.detail = 'jsqr=' + res.decoders.jsqr.verdict + ', zxing=' + res.decoders.zxing.verdict
      }
    }
    // 耗时是环境相关的观测值，默认不进报告正体（否则报告不可复现）；只有显式要求时才带
    if (opts && opts.withTiming) record.ms = Date.now() - t0
    results.push(record)
  }
  return results
}

module.exports = { runVariants, VARIANTS, downscale, boxBlur, linear, glare, saltPepper, rotate }
