#!/usr/bin/env node
'use strict'

/**
 * 解码器版本对照：确认锁定的版本范围不改变判定语义
 *
 * 背景：@zxing/library 0.22.0 起 engines.node >= 24，npm 会静默跳过不满足的可选依赖。
 * 本项目锁 ^0.21.3。这个脚本用来证明"锁定不是靠猜"：
 * 把另一个版本装到临时目录，用同一组场景比对结论。
 *
 * 用法：
 *   node scripts/decoder-version-parity.js --baseline <dir> --compare <dir>
 *   两个 dir 都是"含 node_modules/@zxing/library 的目录"
 *
 * 例：
 *   mkdir -p /tmp/zx-new && cd /tmp/zx-new && npm i @zxing/library@0.23.0
 *   node scripts/decoder-version-parity.js --baseline . --compare /tmp/zx-new
 *
 * 退出码：0 无分歧 / 1 有分歧（说明锁定会改变判定，需重新评估）/ 2 参数或依赖缺失
 */

const path = require('path')
const ROOT = path.join(__dirname, '..')

const G = require(path.join(ROOT, 'lib/scanproof/geometry'))
const V = require(path.join(ROOT, 'lib/scanproof/variants'))
const decoder = require(path.join(ROOT, 'lib/scanproof/decoder'))

function argOf (name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}

const baselineDir = argOf('--baseline')
const compareDir = argOf('--compare')

if (!baselineDir || !compareDir) {
  process.stderr.write('用法：node scripts/decoder-version-parity.js --baseline <dir> --compare <dir>\n')
  process.exitCode = 2
  process.exit()
}

function loadZx (baseDir) {
  const p = path.join(path.resolve(baseDir), 'node_modules/@zxing/library')
  try {
    return { zx: require(p), version: require(path.join(path.resolve(baseDir), 'node_modules/@zxing/library/package.json')).version }
  } catch (e) {
    process.stderr.write('无法加载 ' + p + '：' + e.message + '\n')
    return null
  }
}

function makeDecoder (zx) {
  const reader = new zx.MultiFormatReader()
  reader.setHints(new Map([
    [zx.DecodeHintType.POSSIBLE_FORMATS, [zx.BarcodeFormat.QR_CODE]],
    [zx.DecodeHintType.TRY_HARDER, true]
  ]))
  return (rgba, w, h) => {
    const lum = new Uint8ClampedArray(w * h)
    for (let i = 0; i < w * h; i++) {
      lum[i] = (rgba[i * 4] * 0.299 + rgba[i * 4 + 1] * 0.587 + rgba[i * 4 + 2] * 0.114) | 0
    }
    const bmp = new zx.BinaryBitmap(new zx.HybridBinarizer(new zx.RGBLuminanceSource(lum, w, h)))
    try { return reader.decode(bmp).getText() } catch (e) { return null } finally { reader.reset() }
  }
}

const base = loadZx(baselineDir)
const other = loadZx(compareDir)
if (!base || !other) {
  process.exitCode = 2
  process.exit()
}

const T = 'https://example.com/order/12345'
const CASES = [
  ['baseline', null],
  ['blur1', (r) => V.boxBlur(r.rgba, r.width, r.height, 1)],
  ['blur2', (r) => V.boxBlur(r.rgba, r.width, r.height, 2)],
  ['rotate3', (r) => V.rotate(r.rgba, r.width, r.height, 3)],
  ['rotate5', (r) => V.rotate(r.rgba, r.width, r.height, 5)],
  ['rotate8', (r) => V.rotate(r.rgba, r.width, r.height, 8)],
  ['rotate12', (r) => V.rotate(r.rgba, r.width, r.height, 12)],
  ['rotate15', (r) => V.rotate(r.rgba, r.width, r.height, 15)],
  ['downscale2', (r) => V.downscale(r.rgba, r.width, r.height, 2)],
  ['downscale3', (r) => V.downscale(r.rgba, r.width, r.height, 3)],
  ['noise1pct', (r) => V.saltPepper(r.rgba, r.width, r.height, 0.01)],
  ['noise2pct', (r) => V.saltPepper(r.rgba, r.width, r.height, 0.02)],
  ['lowlight', (r) => V.linear(r.rgba, r.width, r.height, 0.55, 110)]
]

const restore = decoder.silenceZxingNoise()
const dA = makeDecoder(base.zx)
const dB = makeDecoder(other.zx)
const img0 = G.renderRGBA(T, {})

process.stdout.write(`baseline ${base.version}  vs  compare ${other.version}\n\n`)
process.stdout.write('| 场景 | baseline | compare | 一致 |\n| --- | --- | --- | --- |\n')

let mismatch = 0
for (const [name, fn] of CASES) {
  const img = fn ? fn(img0) : img0
  const a = dA(img.rgba, img.width, img.height)
  const b = dB(img.rgba, img.width, img.height)
  const ja = a === T ? 'pass' : a ? 'wrong' : 'fail'
  const jb = b === T ? 'pass' : b ? 'wrong' : 'fail'
  const same = ja === jb
  if (!same) mismatch++
  process.stdout.write(`| ${name} | ${ja} | ${jb} | ${same ? '✓' : '✗'} |\n`)
}

restore()
process.stdout.write(`\n${CASES.length} 个场景，${mismatch} 处分歧\n`)
if (mismatch) {
  process.stdout.write('锁定版本会改变判定语义，需重新评估。\n')
  process.exitCode = 1
}
