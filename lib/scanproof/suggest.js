'use strict'

/**
 * 自动修复建议（suggest fixes）
 *
 * 原则：只在**可证明更优**的方向上改参数，并且每步改动都要重新验收确认变好。
 * 不做"猜测式"调参：候选参数来自几何计算，最终由闸门 + 解码器复核。
 */

const R = require('./report')

const EC_ORDER = ['L', 'M', 'Q', 'H']

/**
 * 生成候选修复方案（不写文件、不改原对象）
 * @param {String} text
 * @param {Object} options 与 QRCode 相同的选项
 * @param {Object} [reportOptions] 透传给 audit
 * @returns {Promise<{before:Object, candidates:Array, best:Object|null}>}
 */
async function suggest (text, options, reportOptions) {
  const opts = reportOptions || {}
  const base = await R.audit(text, options, opts)
  const candidates = []

  // 累积补丁：后一条候选建立在前面所有已验证补丁之上，否则 width 补丁会被 scale 补丁覆盖
  const push = (id, label, patch) => {
    candidates.push({ id, label, patch })
  }

  if (base.geometry.quietZoneModules < 4) {
    push('margin', '把静区补到 4 模块', { margin: 4 })
  }

  if (base.geometry.modulePx < 2) {
    // 用整数 scale 表达"每模块多少像素"，比 width 更稳：
    // width 会被 getScale() 反算成小数比例，导致"修了尺寸又引入非整数缩放"。
    const need = Math.max(2, Math.ceil(base.geometry.scale))
    push('module-pixels', `把 scale 提到 ${need}（每模块 ${need}px）`, { scale: need, width: base.geometry.totalModules * need })
  } else if (!base.geometry.integerScale) {
    const s = Math.max(1, Math.round(base.geometry.scale))
    push('integer-scale', `改用整数比例 scale=${s}（width=${base.geometry.totalModules * s}）`, {
      scale: s,
      width: base.geometry.totalModules * s
    })
  }

  if (base.contrast < 3) {
    push('contrast', '改用纯黑前景（对比度 21:1）', { color: { dark: '#000000', light: '#ffffff' } })
  }

  if (base.decode.consensus === 'read-by-one' || base.decode.consensus === 'no-read-by-any') {
    const cur = EC_ORDER.indexOf(base.geometry.errorCorrectionLevel)
    if (cur < EC_ORDER.length - 1) {
      push('error-correction', '把纠错等级提到 H', { errorCorrectionLevel: 'H' })
    }
  }

  // 逐个候选实际跑一遍，只保留"结论严格变好"的；补丁按顺序累积
  const verified = []
  let current = Object.assign({}, options || {})
  let currentReport = base
  for (const c of candidates) {
    const patched = mergeOptions(current, c.patch)
    const after = await R.audit(text, patched, opts)
    const better = rank(after.verdict) > rank(currentReport.verdict)
    const notWorseGates = after.summary.error <= currentReport.summary.error
    const improves = better && notWorseGates
    verified.push({
      id: c.id,
      label: c.label,
      patch: c.patch,
      options: patched,
      verdict: after.verdict,
      improves,
      delta: {
        verdict: currentReport.verdict + ' → ' + after.verdict,
        error: after.summary.error - currentReport.summary.error,
        warning: after.summary.warning - currentReport.summary.warning
      }
    })
    if (improves) {
      current = patched
      currentReport = after
    }
  }

  verified.sort((a, b) => (b.improves ? 1 : 0) - (a.improves ? 1 : 0))

  return {
    before: base,
    candidates: verified,
    best: verified.find(v => v.improves) || null
  }
}

/**
 * 把所有已验证有效的补丁合并成一个 options，并返回最终验收报告
 */
async function applySuggestions (text, options, reportOptions) {
  const res = await suggest(text, options, reportOptions)
  let merged = Object.assign({}, options || {})
  for (const c of res.candidates) {
    if (c.improves) merged = c.options
  }
  const final = await R.audit(text, merged, reportOptions || {})
  return { options: merged, report: final, applied: res.candidates.filter(c => c.improves) }
}

function mergeOptions (base, patch) {
  const out = Object.assign({}, base)
  for (const k of Object.keys(patch)) {
    if (k === 'color') {
      out.color = Object.assign({}, base.color || {}, patch.color)
    } else {
      out[k] = patch[k]
    }
  }
  return out
}

function rank (v) {
  return v === 'pass' ? 3 : v === 'warn' ? 2 : v === 'fail' ? 1 : 0
}

module.exports = { suggest, applySuggestions }
