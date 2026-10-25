const test = require('tap').test
const path = require('path')
const G = path.join(__dirname, '../../lib/scanproof/')
const decoder = require(G + 'decoder')
const { audit } = require(G + 'report')

const restore = decoder.silenceZxingNoise()
const TEXT = 'https://example.com/order/12345'

test('audit - 默认参数通过', function (t) {
  return audit(TEXT, {}, {}).then(function (rep) {
    t.equal(rep.verdict, 'pass', '默认参数 pass')
    t.equal(rep.decode.consensus, 'read-by-both', '双读')
    t.equal(rep.summary.error, 0, '无 error')
    t.equal(rep.summary.warning, 0, '无 warning（边界变体不参与判定）')
    t.equal(rep.contrast, 21, '对比度 21')
    t.equal(rep.quietZoneForeignRatio, 0, '静区无侵入')
    t.equal(rep.schema, 'scanproof/report@1', 'schema 固定')
    t.ok(rep.generatedBy.indexOf('scanproof@') === 0, 'generatedBy 带头版本')
    t.end()
  })
})

test('audit - margin=0 判 fail 且给出修复', function (t) {
  return audit(TEXT, { margin: 0 }, {}).then(function (rep) {
    t.equal(rep.verdict, 'fail', '静区违规 → fail')
    const f = rep.gates.find(g => g.id === 'quiet-zone')
    t.ok(f, '有 quiet-zone')
    t.equal(f.severity, 'error', 'error 级')
    t.ok(f.fix.indexOf('margin') >= 0, '修复建议提到 margin')
    t.end()
  })
})

test('audit - 反色判 fail（默认检测读不出）', function (t) {
  return audit(TEXT, { color: { dark: '#ffffff', light: '#000000' } }, {}).then(function (rep) {
    t.equal(rep.verdict, 'fail', '默认读不出 → fail')
    t.equal(rep.decode.consensus, 'no-read-by-any', '双读失败')
    t.ok(rep.invertedRetry, '有反色复测记录')
    t.equal(rep.invertedRetry.verdict, 'read', 'attemptBoth 后读出')
    t.ok(rep.warnings.some(w => w.indexOf('反色') >= 0), '有反色说明')
    const p = rep.gates.find(g => g.id === 'polarity')
    t.equal(p.severity, 'warning', '极性是 warning 不是 error')
    t.end()
  })
})

test('audit - 非整数缩放判 warn', function (t) {
  return audit(TEXT, { width: 100 }, {}).then(function (rep) {
    t.equal(rep.verdict, 'warn', '能读出但比例不整数 → warn')
    t.ok(rep.gates.some(g => g.id === 'integer-scale'), '有 integer-scale')
    t.ok(rep.gates.some(g => g.id === 'occlusion'), '静区被压的实证')
    t.end()
  })
})

test('audit - 确定性：同输入两次报告完全一致', function (t) {
  return Promise.all([audit(TEXT, { margin: 2 }, {}), audit(TEXT, { margin: 2 }, {})]).then(function (r) {
    const a = JSON.stringify(r[0])
    const b = JSON.stringify(r[1])
    t.equal(a, b, '两次 JSON 逐字节相同')
    t.end()
  })
})

test('audit - 关掉解码器时结论为 inconclusive（不谎称通过）', function (t) {
  return audit(TEXT, {}, { requireDecoders: false }).then(function (rep) {
    t.equal(rep.verdict, 'inconclusive', '未验证 ≠ 通过')
    t.equal(rep.decode.consensus, 'unavailable', '解码结论标 unavailable')
    t.ok(rep.warnings.some(w => w.indexOf('未验证') >= 0 || w.indexOf('不可用') >= 0), '有中文说明')
    t.end()
  })
})

test('audit - 关掉变体扫描时更快且不产生 variant findings', function (t) {
  return audit(TEXT, {}, { variants: false }).then(function (rep) {
    t.equal(rep.variants.length, 0, '没有变体结果')
    t.equal(rep.verdict, 'pass', '仍判 pass')
    t.end()
  })
})

test('audit - 报告可被 JSON 序列化（无 undefined / 循环引用）', function (t) {
  return audit(TEXT, { width: 111 }).then(function (rep) {
    const s = JSON.stringify(rep)
    t.ok(s.length > 100, '序列化成功，长度 ' + s.length)
    t.equal(JSON.parse(s).verdict, rep.verdict, '往返一致')
    t.end()
  })
})

test('audit - renderText 产出 Markdown 且含关键字段', function (t) {
  const { renderText } = require(G + 'report')
  return audit(TEXT, { margin: 0 }, { variants: false }).then(function (rep) {
    const md = renderText(rep)
    t.ok(md.indexOf('# ScanProof 报告') === 0, '有标题')
    t.ok(md.indexOf('FAIL') >= 0, '含结论')
    t.ok(md.indexOf('quiet-zone') >= 0, '含问题 id')
    t.ok(md.indexOf('ISO/IEC 18004') >= 0, '含规范依据')
    t.end()
  })
})

test('audit - 长文本大版本也稳定', function (t) {
  const long = 'A'.repeat(600) + '/ORDER/2026-10-25/XJ19'
  return audit(long, {}, { variants: false }).then(function (rep) {
    t.ok(rep.geometry.version >= 10, '版本 ≥10，实得 ' + rep.geometry.version)
    t.equal(rep.decode.consensus, 'read-by-both', '大版本仍可读')
    t.ok(rep.verdict === 'pass' || rep.verdict === 'warn', '结论：' + rep.verdict)
    restore()
    t.end()
  })
})
