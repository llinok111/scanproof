#!/usr/bin/env node
'use strict'

/**
 * 度量脚本：回答"验收层到底测出了什么、代价多大"
 *
 * 输出两件事：
 *   1. 事实矩阵：不同参数下产物是否可读（这是 scanproof 判定的事实基础）
 *   2. 成本：每次验收的耗时分布（只报中位数与区间，不报单次值）
 *
 * 用法：node scripts/measure.js [--json]
 */

const path = require('path')
const ROOT = path.join(__dirname, '..')
const { audit } = require(path.join(ROOT, 'lib/scanproof/report'))
const { silenceZxingNoise } = require(path.join(ROOT, 'lib/scanproof/decoder'))
const QRCode = require(path.join(ROOT, 'lib/index'))

const TEXT = 'https://example.com/order/12345'

const CASES = [
  { name: 'default', options: {}, expect: 'pass' },
  { name: 'margin=3', options: { margin: 3 }, expect: 'fail' },
  { name: 'margin=0', options: { margin: 0 }, expect: 'fail' },
  { name: 'width=100 (2.70px/module)', options: { width: 100 }, expect: 'warn' },
  { name: 'width=111 (3px/module)', options: { width: 111 }, expect: 'pass' },
  { name: 'width=40 (EC=M)', options: { width: 40 }, expect: 'fail' },
  { name: 'width=40 (EC=H)', options: { width: 40, errorCorrectionLevel: 'H' }, expect: 'pass' },
  { name: 'inverted', options: { color: { dark: '#ffffff', light: '#000000' } }, expect: 'fail' },
  { name: 'low contrast', options: { color: { dark: '#bbbbbb', light: '#ffffff' } }, expect: 'fail' },
  { name: 'EC=L', options: { errorCorrectionLevel: 'L' }, expect: 'pass' },
  { name: 'long text v10+', options: {}, text: 'A'.repeat(600), expect: 'pass' }
]

function median (arr) {
  const s = arr.slice().sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

async function main () {
  const restore = silenceZxingNoise()
  const rows = []
  for (const c of CASES) {
    const text = c.text || TEXT
    const rep = await audit(text, c.options)
    rows.push({
      case: c.name,
      verdict: rep.verdict,
      expected: c.expect,
      matches: rep.verdict === c.expect,
      decode: rep.decode.consensus,
      modulePx: Number(rep.geometry.modulePx.toFixed(3)),
      pixels: rep.geometry.pixels,
      contrast: rep.contrast,
      gates: rep.gates.map(g => g.severity + ':' + g.id)
    })
  }

  // 成本：同一配置重复 5 次取中位数（单次计时不构成结论）
  const timings = { withVariants: [], noVariants: [], noDecode: [] }
  const reps = 5
  for (let i = 0; i < reps; i++) {
    let t = Date.now()
    await audit(TEXT, {})
    timings.withVariants.push(Date.now() - t)
    t = Date.now()
    await audit(TEXT, {}, { variants: false })
    timings.noVariants.push(Date.now() - t)
    t = Date.now()
    await audit(TEXT, {}, { variants: false, requireDecoders: false })
    timings.noDecode.push(Date.now() - t)
  }

  // 上游生成本身的成本（作为对照）
  const genTimes = []
  for (let i = 0; i < reps; i++) {
    const t = Date.now()
    await QRCode.toBuffer(TEXT, { type: 'png' })
    genTimes.push(Date.now() - t)
  }

  const out = {
    generatedAt: new Date().toISOString().slice(0, 10),
    node: process.version,
    platform: process.platform,
    rows,
    timings: {
      generatePngMedianMs: median(genTimes),
      auditFullMedianMs: median(timings.withVariants),
      auditNoVariantsMedianMs: median(timings.noVariants),
      auditNoDecodeMedianMs: median(timings.noDecode),
      auditFullRangeMs: [Math.min.apply(null, timings.withVariants), Math.max.apply(null, timings.withVariants)]
    }
  }

  restore()

  if (process.argv.indexOf('--json') >= 0) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  } else {
    process.stdout.write('| 用例 | 结论 | 期望 | 一致 | 解码 | 模块px | 像素 | 对比度 | 闸门 |\n')
    process.stdout.write('| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n')
    for (const r of rows) {
      process.stdout.write(`| ${r.case} | ${r.verdict} | ${r.expected} | ${r.matches ? '✓' : '✗'} | ${r.decode} | ${r.modulePx} | ${r.pixels} | ${r.contrast} | ${r.gates.join(' ')} |\n`)
    }
    process.stdout.write('\n')
    process.stdout.write(`生成 PNG 中位耗时：${out.timings.generatePngMedianMs} ms\n`)
    process.stdout.write(`完整验收中位耗时：${out.timings.auditFullMedianMs} ms（区间 ${out.timings.auditFullRangeMs[0]}-${out.timings.auditFullRangeMs[1]}，${reps} 次）\n`)
    process.stdout.write(`跳过变体中位耗时：${out.timings.auditNoVariantsMedianMs} ms\n`)
    process.stdout.write(`跳过解码中位耗时：${out.timings.auditNoDecodeMedianMs} ms\n`)
  }

  const mismatched = rows.filter(r => !r.matches)
  if (mismatched.length) {
    process.stderr.write('预期不符：' + mismatched.map(r => r.case).join(', ') + '\n')
    process.exitCode = 1
  }
}

main().catch((e) => {
  process.stderr.write((e && e.stack ? e.stack : String(e)) + '\n')
  process.exitCode = 1
})
