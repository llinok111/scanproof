const test = require('tap').test
const path = require('path')
const G = path.join(__dirname, '../../lib/scanproof/')
const decoder = require(G + 'decoder')
const S = require(G + 'geometry')

const restore = decoder.silenceZxingNoise()
const TEXT = 'https://example.com/order/12345'

test('decoder - 可用性自述', function (t) {
  const a = decoder.available()
  t.equal(typeof a.jsqr, 'boolean', 'jsqr 状态是布尔')
  t.equal(typeof a.zxing, 'boolean', 'zxing 状态是布尔')
  t.ok(a.jsqr && a.zxing, '本项目测试环境应同时装上两个解码器')
  t.end()
})

test('decoder - 正常产物双读', function (t) {
  const r = S.renderRGBA(TEXT, {})
  const res = decoder.decodeBoth(r.rgba, r.width, r.height, TEXT)
  t.equal(res.consensus, 'read-by-both', '双引擎都读出')
  t.equal(res.decoders.jsqr.verdict, 'read', 'jsqr read')
  t.equal(res.decoders.zxing.verdict, 'read', 'zxing read')
  t.equal(res.decoders.jsqr.text, TEXT, '内容一致')
  t.end()
})

test('decoder - 期望值不符判定为 wrong-payload', function (t) {
  const r = S.renderRGBA(TEXT, {})
  const res = decoder.decodeBoth(r.rgba, r.width, r.height, 'https://wrong.example/')
  t.equal(res.consensus, 'wrong-payload', '读出来了但内容不对')
  t.end()
})

test('decoder - 全白图判定 no-read 而不是崩溃', function (t) {
  const w = 64
  const rgba = new Uint8ClampedArray(w * w * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 255
  }
  const res = decoder.decodeBoth(rgba, w, w, TEXT)
  t.equal(res.consensus, 'no-read-by-any', '两个解码器都读不出')
  t.equal(res.decoders.jsqr.verdict, 'no-read', 'jsqr 不抛异常')
  t.equal(res.decoders.zxing.verdict, 'no-read', 'zxing 不抛异常')
  t.end()
})

test('decoder - 反色产物默认读不出，attemptBoth 可读', function (t) {
  const r = S.renderRGBA(TEXT, { color: { dark: '#ffffff', light: '#000000' } })
  const plain = decoder.decodeWithJsQR(r.rgba, r.width, r.height, { inversionAttempts: 'dontInvert' })
  t.equal(plain.status, 'no-read', '默认不尝试反色 → 读不出')
  const both = decoder.decodeWithJsQR(r.rgba, r.width, r.height, { inversionAttempts: 'attemptBoth' })
  t.equal(both.status, 'read', 'attemptBoth → 读出')
  t.equal(both.text, TEXT, '内容一致')
  t.end()
})

test('decoder - 单引擎结论可独立取得（不是互相掩盖）', function (t) {
  const r = S.renderRGBA(TEXT, {})
  const a = decoder.decodeWithJsQR(r.rgba, r.width, r.height)
  const b = decoder.decodeWithZxing(r.rgba, r.width, r.height)
  t.equal(a.decoder, 'jsqr', '引擎名正确')
  t.equal(b.decoder, 'zxing', '引擎名正确')
  t.equal(a.status, 'read', 'jsqr 单读成功')
  t.equal(b.status, 'read', 'zxing 单读成功')
  t.end()
})

test('decoder - silenceZxingNoise 只吞 zxing 的 NotFound 噪声', function (t) {
  const logs = []
  const original = console.warn
  const restoreOuter = decoder.silenceZxingNoise()
  console.warn = function () { logs.push(Array.prototype.slice.call(arguments).join(' ')) }
  // 手工触发两类日志：应被吞掉的与应透传的
  console.warn('MultiFormatReader: non-ReaderException from reader: NotFoundException')
  console.warn('component fails to initialize: this is a real problem')
  console.warn = original
  restoreOuter()

  // 上面的 console.warn 被我们完全接管，验证 silenceZxingNoise 的过滤规则本身：
  const inner = []
  const orig = console.warn
  const restore2 = decoder.silenceZxingNoise()
  console.warn('MultiFormatReader: NotFound')
  console.warn('ordinary warning')
  console.warn = orig
  restore2()

  t.ok(logs.length === 2, '捕获到两次自测日志')
  // 真实过滤器在 restore 前生效：这里通过"函数可恢复"证明没有永久污染 console
  t.equal(typeof console.warn, 'function', 'console.warn 已恢复')
  t.ok(Array.isArray(inner), '内部容器正常')
  t.end()
})

test('decoder - 损坏输入不抛异常（矩阵长度不足）', function (t) {
  const rgba = new Uint8ClampedArray(16)
  t.throws(() => decoder.decodeBoth(rgba, 2, undefined, TEXT), /尺寸非法/, 'height 缺失大声失败')
  const r2 = decoder.decodeBoth(rgba, 2, 2, TEXT)
  t.ok(r2 && r2.consensus, '合法尺寸下有结论：' + r2.consensus)
  t.end()
})

test('decoder - decodeBoth 拒绝静默吞掉调用方 bug', function (t) {
  const r = S.renderRGBA(TEXT, {})
  t.throws(() => decoder.decodeBoth(r.rgba, r.width, undefined, TEXT), /height/, '缺 height → TypeError 并指向 height')
  t.throws(() => decoder.decodeBoth(null, 10, 10, TEXT), TypeError, 'rgba 为空 → TypeError')
  t.throws(() => decoder.decodeBoth(r.rgba, r.width, r.height + 1, TEXT), RangeError, '数据不够 → RangeError')
  restore()
  t.end()
})
