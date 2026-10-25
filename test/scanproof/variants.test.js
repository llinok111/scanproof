const test = require('tap').test
const path = require('path')
const fs = require('fs')
const os = require('os')
const G = path.join(__dirname, '../../lib/scanproof/')
const V = require(G + 'variants')
const S = require(G + 'geometry')
const decoder = require(G + 'decoder')
const { suggest, applySuggestions } = require(G + 'suggest')
const { auditBuffer } = require(G + 'buffer')

const restore = decoder.silenceZxingNoise()
const TEXT = 'https://example.com/order/12345'

test('variants - 目录完整性：每个变体都有 id/label/apply', function (t) {
  t.ok(V.VARIANTS.length >= 6, '至少 6 个变体，实得 ' + V.VARIANTS.length)
  for (const v of V.VARIANTS) {
    t.ok(v.id && v.label && typeof v.apply === 'function', v.id + ' 结构完整')
  }
  const ids = V.VARIANTS.map(v => v.id)
  t.equal(new Set(ids).size, ids.length, 'id 不重复')
  t.end()
})

test('variants - 变换是确定性的（同输入同输出）', function (t) {
  const base = S.renderRGBA(TEXT, {})
  for (const v of V.VARIANTS) {
    const a = v.apply(base)
    const b = v.apply(base)
    let same = a.width === b.width && a.height === b.height
    if (same) {
      for (let i = 0; i < a.rgba.length; i++) {
        if (a.rgba[i] !== b.rgba[i]) { same = false; break }
      }
    }
    t.ok(same, v.id + ' 两次变换逐字节相同')
  }
  t.end()
})

test('variants - downscale 尺寸计算', function (t) {
  const r = V.downscale(new Uint8ClampedArray(16 * 16 * 4), 16, 16, 2)
  t.equal(r.width, 8, '宽减半')
  t.equal(r.height, 8, '高减半')
  t.equal(r.rgba.length, 8 * 8 * 4, '长度正确')
  const r3 = V.downscale(new Uint8ClampedArray(15 * 15 * 4), 15, 15, 2)
  t.equal(r3.width, 7, '奇数宽向下取整')
  t.end()
})

test('variants - rotate 输出包围盒', function (t) {
  const r = V.rotate(new Uint8ClampedArray(10 * 10 * 4), 10, 10, 90)
  t.equal(r.width, 10, '90° 旋转后宽不变（±1 取整）')
  t.equal(r.height, 10, '90° 旋转后高不变')
  const r45 = V.rotate(new Uint8ClampedArray(10 * 10 * 4), 10, 10, 45)
  t.ok(r45.width > 10, '45° 后包围盒变大，实得 ' + r45.width)
  t.end()
})

test('variants - 抗噪能力回到基线（默认产物在非边界变体下全部可读）', function (t) {
  return V.runVariants(TEXT, {}, {}).then(function (results) {
    for (const r of results) {
      if (r.optional) continue
      t.equal(r.verdict, 'read-by-both', r.id + ' 应双读，实得 ' + r.verdict)
    }
    t.end()
  })
})

test('variants - 可选标记被保留', function (t) {
  return V.runVariants(TEXT, {}, {}).then(function (results) {
    const opt = results.filter(r => r.optional).map(r => r.id)
    t.ok(opt.indexOf('downscale-3x') >= 0, 'downscale-3x 标记为边界')
    t.ok(opt.indexOf('glare') >= 0, 'glare 标记为边界')
    t.end()
  })
})

test('variants - 指定 ids 只跑子集', function (t) {
  return V.runVariants(TEXT, {}, { ids: ['blur-1px'] }).then(function (results) {
    t.equal(results.length, 1, '只跑 1 个')
    t.equal(results[0].id, 'blur-1px', 'id 正确')
    t.end()
  })
})

test('suggest - margin=0 给出并验证 margin 补丁', function (t) {
  return suggest(TEXT, { margin: 0 }, { variants: false }).then(function (res) {
    t.equal(res.before.verdict, 'fail', '修复前 fail')
    const c = res.candidates.find(x => x.id === 'margin')
    t.ok(c, '有 margin 候选')
    t.equal(c.improves, true, '被采纳')
    t.equal(c.verdict, 'pass', '修复后 pass')
    t.ok(res.best, 'best 非空')
    t.end()
  })
})

test('suggest - 空补丁序列：本身通过时无候选', function (t) {
  return suggest(TEXT, {}, { variants: false }).then(function (res) {
    t.equal(res.candidates.length, 0, '无需修复')
    t.equal(res.best, null, 'best 为 null')
    t.end()
  })
})

test('suggest - applySuggestions 返回可用 options 且验收通过', function (t) {
  return applySuggestions(TEXT, { margin: 1 }, { variants: false }).then(function (r) {
    t.equal(r.report.verdict, 'pass', '合并后 pass')
    t.equal(r.options.margin, 4, 'margin 被改成 4')
    t.ok(r.applied.length >= 1, '至少采纳一条')
    t.end()
  })
})

test('suggest - 冲突补丁不被采纳（不会越修越差）', function (t) {
  return suggest(TEXT, { width: 40 }, { variants: false }).then(function (res) {
    for (const c of res.candidates) {
      if (!c.improves) {
        t.ok(!(c.delta.verdict.endsWith('pass')), c.id + ' 未采纳项不应是 pass')
      }
    }
    t.ok(res.candidates.length > 0, '至少有候选')
    t.end()
  })
})

test('buffer - 对真实 PNG 文件验收', function (t) {
  const QRCode = require(path.join(__dirname, '../../lib/index'))
  const tmp = path.join(os.tmpdir(), 'scanproof-buffer-test-' + process.pid + '.png')
  return QRCode.toFile(tmp, TEXT, { type: 'png' }).then(function () {
    return auditBuffer(tmp)
  }).then(function (rep) {
    t.equal(rep.verdict, 'pass', '默认产物 pass')
    t.equal(rep.payload, TEXT, '读出原文')
    t.equal(Math.round(rep.geometry.quietZoneModules), 4, '反推静区 4 模块，实得 ' + rep.geometry.quietZoneModules.toFixed(2))
    t.ok(fs.existsSync(tmp), '文件存在')
    fs.unlinkSync(tmp)
    t.end()
  })
})

test('buffer - 无静区 PNG 被判 fail', function (t) {
  const QRCode = require(path.join(__dirname, '../../lib/index'))
  const tmp = path.join(os.tmpdir(), 'scanproof-buffer-m0-' + process.pid + '.png')
  return QRCode.toFile(tmp, TEXT, { type: 'png', margin: 0 }).then(function () {
    return auditBuffer(tmp)
  }).then(function (rep) {
    t.equal(rep.verdict, 'fail', '无静区 fail')
    t.ok(rep.gates.some(g => g.id === 'quiet-zone'), '有 quiet-zone')
    fs.unlinkSync(tmp)
    t.end()
  })
})

test('buffer - 不存在的文件 / 非 PNG 文件给出可读错误', function (t) {
  return Promise.all([
    auditBuffer(path.join(os.tmpdir(), 'definitely-not-here-' + process.pid + '.png')),
    (function () {
      const tmp = path.join(os.tmpdir(), 'scanproof-notpng-' + process.pid + '.png')
      fs.writeFileSync(tmp, 'this is not a png')
      return auditBuffer(tmp).then(function (rep) { fs.unlinkSync(tmp); return rep })
    })()
  ]).then(function (r) {
    t.equal(r[0].verdict, 'fail', '缺文件 fail')
    t.ok(/读取文件失败/.test(r[0].error), '错误信息明确')
    t.equal(r[1].verdict, 'fail', '非 PNG fail')
    t.ok(/不是可解析的 PNG/.test(r[1].error), '错误信息明确')
    restore()
    t.end()
  })
})
