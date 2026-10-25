'use strict'

/**
 * 报告引擎：把几何、闸门、双解码、变体扫描合成一份确定性报告
 *
 * 报告结构（v1）：
 * {
 *   schema, generatedBy, input: {text, options},
 *   geometry, contrast,
 *   gates: [{id, severity, title, ref, detail, fix}],
 *   decode: {consensus, decoders:{jsqr,zxing}},
 *   variants: [{id, transform, enabled, verdict}],
 *   verdict: 'pass' | 'warn' | 'fail' | 'inconclusive',
 *   warnings: [..]
 * }
 */

const S = require('./geometry')
const { GATES } = require('./gates')
const decoder = require('./decoder')
const variantsLib = require('./variants')

const SCHEMA = 'scanproof/report@1'

function severityRank (sev) {
  return sev === 'error' ? 3 : sev === 'warning' ? 2 : sev === 'info' ? 1 : 0
}

function runGates (g, ctx) {
  const findings = []
  const shared = {}
  for (const gate of GATES) {
    let finding = null
    try {
      finding = gate.check(g, Object.assign({}, ctx, { _shared: shared }))
    } catch (e) {
      findings.push({
        id: gate.id,
        severity: 'info',
        title: gate.title,
        ref: gate.ref,
        detail: '闸门自身执行异常，已跳过（不计入通过）：' + e.message,
        fix: ''
      })
      continue
    }
    if (finding) {
      findings.push({
        id: gate.id,
        severity: gate.severity,
        title: gate.title,
        ref: gate.ref,
        detail: finding.detail,
        fix: finding.fix || ''
      })
    }
  }
  return { findings, shared }
}

/**
 * 决定最终结论
 * - fail：读不出（双引擎都失败）/ 读错 / 存在 error 级闸门
 * - warn：能读出，但存在 warning 级闸门或仅在单个解码器下可读
 * - pass：双引擎都读出、无 error/warning
 * - inconclusive：解码器不可用且无 error 级问题 —— 不能声称通过
 */
/**
 * 决定结论。传入的 findings **只含产物本身**的闸门结论，
 * 变体失败由调用方另行降级（否则"默认参数"也会被误判成 fail）。
 */
function decideVerdict (findings, decode, variantResults, opts) {
  const errors = findings.filter(f => f.severity === 'error')
  const warns = findings.filter(f => f.severity === 'warning')

  const disabled = opts.requireDecoders === false
  if (disabled) {
    return errors.length ? 'fail' : warns.length ? 'warn' : 'inconclusive'
  }

  if (decode.consensus === 'unavailable') return 'inconclusive'
  if (decode.consensus === 'no-read-by-any') return 'fail'
  if (decode.consensus === 'wrong-payload') return 'fail'

  if (errors.length) return 'fail'
  if (warns.length || decode.consensus === 'read-by-one') return 'warn'
  return 'pass'
}

function summarize (findings) {
  const by = { error: 0, warning: 0, info: 0 }
  for (const f of findings) by[f.severity] = (by[f.severity] || 0) + 1
  return by
}

/**
 * 运行一次完整验收
 * @param {String} text 待编码原文
 * @param {Object} [options] 与 QRCode.toBuffer 相同的选项（本模块不改写任何值）
 * @param {Object} [reportOptions]
 * @param {Boolean} [reportOptions.variants=true] 是否跑变体扫描
 * @param {String[]} [reportOptions.variantIds] 只跑指定变体
 * @param {Boolean} [reportOptions.requireDecoders=true] false 时只做几何+闸门（离线可用）
 * @returns {Promise<Object>} 报告
 */
async function audit (text, options, reportOptions) {
  const opts = reportOptions || {}
  const qrOptions = Object.assign({}, options || {})
  const geometry = S.geometry(text, qrOptions)
  const rendered = S.renderRGBA(text, qrOptions)

  const ctx = {
    rgba: rendered.rgba,
    width: rendered.width,
    height: rendered.height
  }

  const { findings: gateFindings, shared } = runGates(geometry, ctx)
  const contrast = S.contrastRatio(geometry.color.dark, geometry.color.light)

  const av = decoder.available()
  const decodeEnabled = opts.requireDecoders !== false && (av.jsqr || av.zxing)
  const warnings = []
  if (opts.requireDecoders === false) {
    warnings.push('已按要求跳过解码（--no-decode）：本次只做了几何与规范闸门检查，可扫性未验证')
  } else if (!av.jsqr && !av.zxing) {
    warnings.push('两个解码器均不可用：本次只做了几何与闸门检查，可扫性未验证')
  }
  if (opts.requireDecoders !== false && !av.jsqr) warnings.push('jsQR 不可用（npm i jsqr），该引擎结论为 unavailable')
  if (opts.requireDecoders !== false && !av.zxing) warnings.push('@zxing/library 不可用（npm i @zxing/library），该引擎结论为 unavailable')

  const decode = decodeEnabled
    ? decoder.decodeBoth(rendered.rgba, rendered.width, rendered.height, text)
    : { consensus: 'unavailable', decoders: { jsqr: { status: 'unavailable', verdict: 'unavailable', decoder: 'jsqr' }, zxing: { status: 'unavailable', verdict: 'unavailable', decoder: 'zxing' } } }
  // 反色产物额外做一次 attemptBoth 复测
  let invertedRetry = null
  const isInverted = geometry.polarity === 'inverted'
  if (decodeEnabled && av.jsqr && isInverted) {
    const retry = decoder.decodeWithJsQR(rendered.rgba, rendered.width, rendered.height, { inversionAttempts: 'attemptBoth' })
    invertedRetry = Object.assign({}, retry, { verdict: retry.status === 'read' ? (retry.text === text ? 'read' : 'wrong-payload') : retry.status })
    if (invertedRetry.verdict === 'read') {
      warnings.push('产物为反色：默认检测读不出，开启 inversionAttempts 后可读。请确认扫码端支持反色（多数手机原生相机支持，部分小程序/嵌入式扫码器不支持）')
    } else if (invertedRetry.verdict === 'no-read') {
      warnings.push('产物为反色，且开启 inversionAttempts 后仍读不出')
    }
  }

  let variantResults = []
  if (opts.variants !== false) {
    variantResults = await variantsLib.runVariants(text, qrOptions, {
      ids: opts.variantIds,
      enabled: decodeEnabled
    })
  }

  const verdict = decideVerdict(gateFindings, decode, variantResults, opts)
  // 只有必须通过的变体失败才计入 findings；optional（边界场景）只在表里展示，不参与判定
  const variantFindings = variantResults
    .filter(v => v.enabled !== false && v.optional !== true && v.verdict === 'no-read-by-any')
    .map(v => ({
      id: 'variant:' + v.id,
      // 变体失败是"劣化条件下失效"的证据，不是产物缺陷 → warning
      severity: 'warning',
      title: '变体场景不可读：' + v.label,
      ref: 'docs/VARIANTS.md',
      detail: v.detail || '在该变体下双解码器均未读出原文',
      fix: v.fix || ''
    }))

  const allFindings = gateFindings.concat(variantFindings)
  const variantHardFail = variantResults.some(v => v.enabled !== false && v.optional !== true && v.verdict === 'no-read-by-any')
  // 变体失败只在"基础产物可读"时才降级：此时结论是 warn（劣化条件失效）；
  // 基础产物本身不可读时 verdict 已是 fail，无需再降。
  let finalVerdict = verdict
  if (variantHardFail && finalVerdict === 'pass') finalVerdict = 'warn'

  return {
    schema: SCHEMA,
    generatedBy: 'scanproof@' + require('./version'),
    input: {
      text,
      options: normalizeOptions(qrOptions)
    },
    geometry,
    contrast: Number(contrast.toFixed(2)),
    quietZoneForeignRatio: typeof shared._quietZoneForeignRatio === 'number'
      ? Number(shared._quietZoneForeignRatio.toFixed(6))
      : null,
    gates: allFindings,
    summary: summarize(allFindings),
    decode,
    invertedRetry,
    variants: variantResults,
    verdict: finalVerdict,
    warnings
  }
}

function normalizeOptions (options) {
  // 只保留会影响产物的键，保证报告可对比
  const keys = ['version', 'errorCorrectionLevel', 'maskPattern', 'margin', 'scale', 'width', 'type']
  const out = {}
  for (const k of keys) if (typeof options[k] !== 'undefined') out[k] = options[k]
  if (options.color) {
    out.color = {}
    if (options.color.dark) out.color.dark = options.color.dark
    if (options.color.light) out.color.light = options.color.light
  }
  return out
}

/**
 * 把报告渲染成人类可读的 Markdown（CLI 与 README 用同一份）
 */
function renderText (rep) {
  const L = []
  const icon = { pass: '✅', warn: '⚠️', fail: '❌', inconclusive: '❔' }
  L.push('# ScanProof 报告')
  L.push('')
  L.push(`**结论：${icon[rep.verdict] || ''} ${rep.verdict.toUpperCase()}**`)
  L.push('')
  L.push('| 项 | 值 |')
  L.push('| --- | --- |')
  L.push(`| 原文 | \`${escapeCell(rep.input.text)}\` |`)
  L.push(`| 版本 / 纠错 | v${rep.geometry.version} / ${rep.geometry.errorCorrectionLevel} |`)
  L.push(`| 模块数 | ${rep.geometry.modulesPerSide} × ${rep.geometry.modulesPerSide}（含静区 ${rep.geometry.totalModules}） |`)
  L.push(`| 静区 | ${rep.geometry.quietZoneModules} 模块 / ${fmt(rep.geometry.quietZonePx)} px |`)
  L.push(`| 单模块 | ${fmt(rep.geometry.modulePx)} px${rep.geometry.integerScale ? '（整数比例）' : '（非整数比例）'} |`)
  L.push(`| 像素 | ${rep.geometry.pixels} × ${rep.geometry.pixels} |`)
  L.push(`| 极性 | ${rep.geometry.polarity} |`)
  L.push(`| 对比度 | ${rep.contrast}:1 |`)
  L.push(`| 解码 | ${rep.decode.consensus}（jsqr=${rep.decode.decoders.jsqr.verdict}, zxing=${rep.decode.decoders.zxing.verdict}） |`)
  L.push('')

  if (rep.gates.length) {
    L.push('## 发现的问题')
    L.push('')
    for (const g of rep.gates) {
      const tag = g.severity === 'error' ? '**错误**' : g.severity === 'warning' ? '警告' : '提示'
      L.push(`- ${tag} \`${g.id}\` — ${g.title}`)
      if (g.ref) L.push(`  - 依据：${g.ref}`)
      L.push(`  - 现象：${g.detail}`)
      if (g.fix) L.push(`  - 建议：${g.fix}`)
    }
    L.push('')
  } else {
    L.push('## 发现的问题')
    L.push('')
    L.push('无。')
    L.push('')
  }

  if (rep.variants && rep.variants.length) {
    L.push('## 劣化场景')
    L.push('')
    L.push('| 场景 | 尺寸 | jsQR | zXing | 结论 |')
    L.push('| --- | --- | --- | --- | --- |')
    for (const v of rep.variants) {
      const d = v.decoders || {}
      L.push(`| ${v.label}${v.optional ? '（边界，不参与判定）' : ''} | ${v.size} | ${d.jsqr || v.verdict} | ${d.zxing || v.verdict} | ${v.verdict} |`)
    }
    L.push('')
  }

  if (rep.warnings && rep.warnings.length) {
    L.push('## 备注')
    L.push('')
    for (const w of rep.warnings) L.push(`- ${w}`)
    L.push('')
  }

  L.push('---')
  L.push(`由 ${rep.generatedBy} 生成。判定依据见 docs/LIMITS.md（能力边界）。`)
  return L.join('\n')
}

function escapeCell (s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function fmt (n) {
  if (typeof n !== 'number' || !isFinite(n)) return String(n)
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

module.exports = { audit, SCHEMA, decideVerdict, severityRank, runGates, renderText }
