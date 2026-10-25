const test = require('tap').test
const path = require('path')

// 这些用例防的是"下游把内部接口当公开接口用"导致的隐性破坏：
// 上游 lib/ 的导出面一旦被我改动，这里会红。
const ROOT = path.join(__dirname, '../..')
const QRCode = require(path.join(ROOT, 'lib/index'))
const core = require(path.join(ROOT, 'lib/core/qrcode'))
const SvgRenderer = require(path.join(ROOT, 'lib/renderer/svg'))
const PngRenderer = require(path.join(ROOT, 'lib/renderer/png'))
const scanproof = require(path.join(ROOT, 'lib/scanproof/index'))

test('compat - 上游公共 API 仍然齐全', function (t) {
  for (const fn of ['create', 'toCanvas', 'toString', 'toDataURL', 'toBuffer', 'toFile', 'toFileStream']) {
    t.equal(typeof QRCode[fn], 'function', 'QRCode.' + fn + ' 存在')
  }
  t.end()
})

test('compat - toString(svg) 前缀与 viewBox 未变', function (t) {
  return QRCode.toString('i am a pony!', { type: 'svg' }).then(function (svg) {
    t.ok(svg.indexOf('<svg xmlns="http://www.w3.org/2000/svg"') === 0, '仍以 <svg 开头')
    // 'i am a pony!' 是版本 1（21 模块），viewBox = 21 + 2*4 = 29
    t.ok(svg.indexOf('viewBox="0 0 29 29"') > 0, 'viewBox 仍是 29（21+2*4）')
    t.ok(svg.indexOf('shape-rendering="crispEdges"') > 0, '仍带 crispEdges')
    t.end()
  })
})

test('compat - 掩码选择与上游一致（默认参数下 8 个掩码中选同一个）', function (t) {
  const auto = core.create('compatibility-check')
  const masked = core.create('compatibility-check', { maskPattern: auto.maskPattern })
  t.equal(auto.maskPattern, masked.maskPattern, '显式指定与自动选择结果一致')
  t.ok(auto.maskPattern >= 0 && auto.maskPattern <= 7, '掩码在 0-7')
  t.end()
})

test('compat - PNG 渲染器输出尺寸契约未变', function (t) {
  const opts = { margin: 4, scale: 4 }
  const qr = core.create('size-check', opts)
  const png = PngRenderer.render(qr, opts)
  t.equal(png.width, (qr.modules.size + 8) * 4, '宽度 = (模块数+8)*4')
  t.end()
})

test('compat - scanproof 只读不写：调用后上游行为完全一致', function (t) {
  const before = core.create('no-side-effect')
  return scanproof.audit('no-side-effect', {}, { variants: false }).then(function () {
    const after = core.create('no-side-effect')
    t.equal(before.maskPattern, after.maskPattern, '掩码未变')
    t.equal(before.modules.size, after.modules.size, '模块数未变')
    let diff = 0
    for (let i = 0; i < before.modules.data.length; i++) {
      if (before.modules.data[i] !== after.modules.data[i]) diff++
    }
    t.equal(diff, 0, '矩阵逐位相同')
    t.end()
  })
})

test('compat - 上游错误信息未被改写', function (t) {
  t.throws(function () { core.create('https://www.google.com', { version: 1, errorCorrectionLevel: 'H' }) },
    /chosen QR Code version cannot contain this amount of data/,
    '版本不足的报错文案仍是上游原文')
  t.end()
})

test('compat - scanproof 不改变默认 SVG 输出（byte 级）', function (t) {
  return Promise.all([
    QRCode.toString('https://example.com', { type: 'svg' }),
    scanproof.audit('https://example.com', {}, { variants: false }).then(function () {
      return QRCode.toString('https://example.com', { type: 'svg' })
    })
  ]).then(function (r) {
    t.equal(r[0], r[1], 'audit 前后 SVG 输出逐字节相同')
    t.end()
  })
})

test('compat - SvgRenderer.render 可直接调用（下游常见用法）', function (t) {
  const qr = core.create('direct-call')
  const svg = SvgRenderer.render(qr, {})
  t.ok(svg.indexOf('<svg') === 0, '返回 SVG 字符串')
  t.end()
})
