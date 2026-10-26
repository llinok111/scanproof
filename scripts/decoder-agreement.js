#!/usr/bin/env node
'use strict'

/**
 * 分歧搜索：在两个解码器之间找"结论不一致"的场景
 *
 * 这是双引擎设计的依据来源。docs/EVIDENCE.md G4 的数字由本脚本产出，可随时复现。
 *
 * 用法：
 *   node scripts/decoder-agreement.js            # 表格 + 汇总
 *   node scripts/decoder-agreement.js --json     # 机器可读
 *
 * 输出：总场景数、分歧数、按变体汇总、代表性分歧行。
 * 退出码：0 采集完成（无论是否找到分歧）/ 1 解码器不可用
 */

const path = require('path')
const ROOT = path.join(__dirname, '..')

const G = require(path.join(ROOT, 'lib/scanproof/geometry'))
const V = require(path.join(ROOT, 'lib/scanproof/variants'))
const decoder = require(path.join(ROOT, 'lib/scanproof/decoder'))

const restore = decoder.silenceZxingNoise()

if (!decoder.available().jsqr || !decoder.available().zxing) {
  process.stderr.write('需要两个解码器：npm i jsqr @zxing/library\n')
  process.exitCode = 1
  process.exit()
}

const TEXTS = [
  ['short', 'https://a.co/1'],
  ['medium', 'https://example.com/order/12345'],
  ['long', 'A'.repeat(400) + '/ORDER/XJ19']
]

function cases () {
  const out = []
  for (const deg of [2, 3, 4, 6, 8, 10, 12, 15, 20, 25, 30]) {
    out.push(['rot' + deg, (r) => V.rotate(r.rgba, r.width, r.height, deg)])
  }
  for (const rad of [1, 2, 3]) out.push(['blur' + rad, (r) => V.boxBlur(r.rgba, r.width, r.height, rad)])
  for (const f of [2, 3, 4, 5, 6, 7]) out.push(['down' + f, (r) => V.downscale(r.rgba, r.width, r.height, f)])
  for (const p of [0.005, 0.01, 0.02, 0.03, 0.05]) out.push(['noise' + p, (r) => V.saltPepper(r.rgba, r.width, r.height, p)])
  for (const g of [0.3, 0.5, 0.7]) out.push(['gain' + g, (r) => V.linear(r.rgba, r.width, r.height, g, 128 * (1 - g))])
  return out
}

function main () {
  const json = process.argv.indexOf('--json') >= 0
  let total = 0
  const diverge = []

  for (const [tname, text] of TEXTS) {
    for (const scale of [2, 4, 6]) {
      const base = G.renderRGBA(text, { scale })
      for (const [cname, fn] of cases()) {
        const img = fn(base)
        total++
        const res = decoder.decodeBoth(img.rgba, img.width, img.height, text)
        const ja = res.decoders.jsqr.verdict
        const jb = res.decoders.zxing.verdict
        if (ja !== jb) {
          diverge.push({ text: tname, scale, baseWidth: base.width, case: cname, size: img.width, jsqr: ja, zxing: jb })
        }
      }
    }
  }

  const byCase = {}
  for (const d of diverge) byCase[d.case] = (byCase[d.case] || 0) + 1

  const summary = {
    total,
    divergent: diverge.length,
    ratio: Number((diverge.length / total).toFixed(4)),
    byCase,
    rows: diverge
  }

  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
  } else {
    process.stdout.write(`总场景 ${total}，分歧 ${diverge.length}（${(summary.ratio * 100).toFixed(1)}%）\n\n`)
    if (diverge.length) {
      process.stdout.write('| 文本 | 基础 scale | 变体 | 尺寸 | jsQR | ZXing |\n')
      process.stdout.write('| --- | --- | --- | --- | --- | --- |\n')
      for (const d of diverge) {
        process.stdout.write(`| ${d.text} | ${d.scale} | ${d.case} | ${d.size} | ${d.jsqr} | ${d.zxing} |\n`)
      }
      process.stdout.write('\n按变体汇总：' + JSON.stringify(byCase) + '\n')
    } else {
      process.stdout.write('本次采集未发现分歧。注意：这不代表两引擎等价，只代表这组场景没覆盖到。\n')
    }
  }

  restore()
}

main()
