const test = require('tap').test
const path = require('path')
const S = require(path.join(__dirname, '../../lib/scanproof/geometry'))

test('geometry - 默认参数', function (t) {
  const g = S.geometry('https://example.com/order/12345', {})
  t.equal(g.version, 3, '应为版本 3')
  t.equal(g.modulesPerSide, 29, '29 模块')
  t.equal(g.marginModules, 4, '默认静区 4')
  t.equal(g.totalModules, 37, '含静区共 37')
  t.equal(g.pixels, 148, '4px/模块 → 148px')
  t.equal(g.modulePx, 4, '模块 4px')
  t.equal(g.integerScale, true, '整数比例')
  t.equal(g.polarity, 'normal', '深码浅底')
  t.end()
})

test('geometry - 极性判定', function (t) {
  const inv = S.geometry('x', { color: { dark: '#ffffff', light: '#000000' } })
  t.equal(inv.polarity, 'inverted', '反色被识别')
  const near = S.geometry('x', { color: { dark: '#333333', light: '#eeeeee' } })
  t.equal(near.polarity, 'normal', '深灰 on 浅灰仍是 normal')
  t.end()
})

test('geometry - 非整数缩放', function (t) {
  const g = S.geometry('https://example.com/order/12345', { width: 100 })
  t.equal(g.pixels, 100, '像素宽度等于传入的 width')
  t.equal(g.integerScale, false, '100/37 不是整数')
  t.ok(Math.abs(g.modulePx - 100 / 37) < 1e-9, '模块像素 = 100/37')
  t.end()
})

test('contrast - WCAG 对比度', function (t) {
  const black = S.contrastRatio('#000000', '#ffffff')
  t.ok(Math.abs(black - 21) < 0.01, '黑白 21:1，实得 ' + black.toFixed(2))
  const grey = S.contrastRatio('#777777', '#ffffff')
  t.ok(grey > 4 && grey < 5, '中灰约 4.48，实得 ' + grey.toFixed(2))
  t.end()
})

test('renderRGBA - 像素数与调色板一致', function (t) {
  const r = S.renderRGBA('https://example.com', {})
  t.equal(r.width, r.width, '宽高相等')
  t.equal(r.rgba.length, r.width * r.width * 4, 'RGBA 长度 = w*h*4')
  // 角落像素应是浅色（静区）
  const i = 0
  t.equal(r.rgba[i], 255, '左上角 R=255')
  t.equal(r.rgba[i + 1], 255, '左上角 G=255')
  t.equal(r.rgba[i + 2], 255, '左上角 B=255')
  t.equal(r.rgba[i + 3], 255, 'alpha 不透明')
  t.end()
})

test('renderRGBA - 与官方 PNG 渲染器逐像素一致', function (t) {
  const PngRenderer = require(path.join(__dirname, '../../lib/renderer/png'))
  const QRCode = require(path.join(__dirname, '../../lib/core/qrcode'))
  const opts = { errorCorrectionLevel: 'Q', margin: 3, width: 200 }
  const qr = QRCode.create('consistency-check', opts)
  const png = PngRenderer.render(qr, opts)
  const mine = S.renderRGBA('consistency-check', opts)
  t.equal(png.width, mine.width, '宽度一致')
  let diff = 0
  for (let i = 0; i < mine.rgba.length; i++) if (png.data[i] !== mine.rgba[i]) diff++
  t.equal(diff, 0, '逐字节相同（' + diff + ' 处不同）')
  t.end()
})
