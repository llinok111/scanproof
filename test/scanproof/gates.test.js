const test = require('tap').test
const path = require('path')
const G = path.join(__dirname, '../../lib/scanproof/')
const S = require(G + 'geometry')
const { GATES } = require(G + 'gates')

function runGates (text, opts) {
  const g = S.geometry(text, opts || {})
  const r = S.renderRGBA(text, opts || {})
  const shared = {}
  const findings = []
  for (const gate of GATES) {
    const f = gate.check(g, { rgba: r.rgba, width: r.width, height: r.height, _shared: shared })
    if (f) findings.push(Object.assign({ id: gate.id, severity: gate.severity }, f))
  }
  return { g, findings, shared }
}

const TEXT = 'https://example.com/order/12345'

test('gate quiet-zone - 默认通过，margin=0/1/3 报错', function (t) {
  t.equal(runGates(TEXT, {}).findings.filter(f => f.id === 'quiet-zone').length, 0, '默认 4 模块不报')
  for (const m of [0, 1, 3]) {
    const f = runGates(TEXT, { margin: m }).findings.find(x => x.id === 'quiet-zone')
    t.ok(f, 'margin=' + m + ' 应报错')
    t.equal(f.severity, 'error', 'severity=error')
  }
  t.end()
})

test('gate module-pixels - 过小报错', function (t) {
  const small = runGates(TEXT, { width: 40 }).findings.find(f => f.id === 'module-pixels')
  t.ok(small, '40px 应报错')
  t.equal(small.severity, 'error', 'error 级')
  const ok = runGates(TEXT, { width: 111 }).findings.find(f => f.id === 'module-pixels')
  t.equal(ok, undefined, '111px（3px/模块）不报')
  t.end()
})

test('gate contrast - 3:1 阈值', function (t) {
  const low = runGates(TEXT, { color: { dark: '#bbbbbb', light: '#ffffff' } }).findings.find(f => f.id === 'contrast')
  t.ok(low, '浅灰 on 白应报错')
  t.equal(low.severity, 'error', 'error 级')
  const ok = runGates(TEXT, { color: { dark: '#777777', light: '#ffffff' } }).findings.find(f => f.id === 'contrast')
  t.equal(ok, undefined, '#777 on 白 对比度 >3 不报')
  t.end()
})

test('gate polarity - 反色只警告', function (t) {
  const f = runGates(TEXT, { color: { dark: '#ffffff', light: '#000000' } }).findings.find(x => x.id === 'polarity')
  t.ok(f, '应提示反色')
  t.equal(f.severity, 'warning', '不是 error')
  t.end()
})

test('gate integer-scale - 非整数缩放警告并给出可行取值', function (t) {
  const f = runGates(TEXT, { width: 100 }).findings.find(x => x.id === 'integer-scale')
  t.ok(f, 'width=100 应警告')
  t.ok(/width=111/.test(f.fix), '建议值应为 111，实得：' + f.fix)
  const none = runGates(TEXT, { width: 148 }).findings.find(x => x.id === 'integer-scale')
  t.equal(none, undefined, '整数比例不报')
  t.end()
})

test('gate occlusion - 正常参数静区零侵占', function (t) {
  const r = runGates(TEXT, {})
  const f = r.findings.find(x => x.id === 'occlusion')
  t.equal(f, undefined, '默认参数静区纯净')
  t.equal(r.shared._quietZoneForeignRatio, 0, '侵占比例 0')
  const bad = runGates(TEXT, { width: 100 })
  t.ok(bad.shared._quietZoneForeignRatio > 0, '非整数缩放时静区被侵入，实得 ' + bad.shared._quietZoneForeignRatio)
  t.end()
})

test('gate opaque-background - 透明背景提示', function (t) {
  const f = runGates(TEXT, { color: { light: '#0000' } }).findings.find(x => x.id === 'opaque-background')
  t.ok(f, '透明背景应有 info 提示')
  t.equal(f.severity, 'info', 'info 级')
  t.end()
})

test('gate error-correction - L 级提示', function (t) {
  const f = runGates(TEXT, { errorCorrectionLevel: 'L' }).findings.find(x => x.id === 'error-correction')
  t.ok(f, 'L 应提示')
  t.equal(f.severity, 'info', 'info 级')
  const h = runGates(TEXT, { errorCorrectionLevel: 'H' }).findings.find(x => x.id === 'error-correction')
  t.equal(h, undefined, 'H 不提示')
  t.end()
})

test('gates - 每条都有 id/severity/title/ref', function (t) {
  for (const g of GATES) {
    t.ok(g.id, g.id + ' 有 id')
    t.ok(['error', 'warning', 'info'].indexOf(g.severity) >= 0, g.id + ' severity 合法')
    t.ok(g.title, g.id + ' 有 title')
    t.ok(g.ref, g.id + ' 有依据（ref）')
  }
  t.end()
})
