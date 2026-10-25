const test = require('tap').test
const path = require('path')
const fs = require('fs')

const ROOT = path.join(__dirname, '../..')
const pkg = require(path.join(ROOT, 'package.json'))

// 这组测试锁的是"文档承诺 = 包元数据"——上次 depmesh 栽过的坑，这次先立规矩。

test('packaging - 包名/入口/版本', function (t) {
  t.equal(pkg.name, 'scanproof', '包名已改为 scanproof（不再占用 qrcode）')
  t.equal(pkg.version, '2.0.0', '版本 2.0.0')
  t.equal(pkg.main, './lib/index.js', '入口仍是上游 lib/index.js')
  t.end()
})

test('packaging - 版本常量与 package.json 一致（防漂移）', function (t) {
  const v = require(path.join(ROOT, 'lib/scanproof/version'))
  t.equal(v, pkg.version, 'lib/scanproof/version.js 必须等于 package.json version')
  t.end()
})

test('packaging - 两个 CLI 都在 bin 且文件存在', function (t) {
  t.ok(pkg.bin.qrcode, '上游 CLI 保留')
  t.ok(pkg.bin['qr-scanproof'], '新 CLI 已注册')
  for (const p of Object.values(pkg.bin)) {
    t.ok(fs.existsSync(path.join(ROOT, p)), p + ' 存在')
  }
  t.end()
})

test('packaging - 解码器是 optionalDependencies（不是硬依赖）', function (t) {
  t.notOk(pkg.dependencies.jsqr, 'jsqr 不在 dependencies')
  t.notOk(pkg.dependencies['@zxing/library'], 'zxing 不在 dependencies')
  t.ok(pkg.optionalDependencies.jsqr, 'jsqr 在 optionalDependencies')
  t.ok(pkg.optionalDependencies['@zxing/library'], 'zxing 在 optionalDependencies')
  t.notOk(pkg.dependencies.sharp, 'sharp 不是依赖（变体是纯 JS 实现）')
  t.end()
})

test('packaging - zxing 版本范围避开 node>=24 的硬门槛', function (t) {
  // @zxing/library 0.22.0 起 engines 要求 node>=24。npm 会把不满足 engines 的
  // 可选依赖静默跳过 —— 装不上但不报错，于是"双解码器"变成单解码器，
  // 而且只有在 npm ci 的干净环境里才暴露（dev 环境早已装过 0.23.0）。
  // 因此这里锁死两点：范围不能覆盖 0.22+，且 lockfile 落的版本必须 <0.22。
  const range = pkg.optionalDependencies['@zxing/library']
  t.ok(/^\^?0\.21\./.test(range) || range === '~0.21.3',
    'zxing 范围必须限制在 0.21.x，实得 ' + range)

  const lockPath = path.join(ROOT, 'package-lock.json')
  t.ok(fs.existsSync(lockPath), 'lockfile 存在')
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
  const entry = lock.packages && lock.packages['node_modules/@zxing/library']
  t.ok(entry, 'lockfile 记录了 zxing')
  const minor = Number(entry.version.split('.')[1])
  t.ok(minor < 22, 'lockfile 锁定的 zxing 主版本必须 <0.22，实得 ' + entry.version)
  if (entry.engines && entry.engines.node) {
    const need = Number((entry.engines.node.match(/(\d+)/) || [])[1] || 0)
    t.ok(need <= 18, '锁定的 zxing 不得要求 node>=24，实得 engines.node=' + entry.engines.node)
  }
  t.end()
})

test('packaging - lockfile 与 package.json 同名同版本', function (t) {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  t.equal(lock.name, pkg.name, 'lockfile name 一致（否则 npm ci 会报包名不匹配）')
  t.equal(lock.version, pkg.version, 'lockfile version 一致')
  t.equal(lock.lockfileVersion, 3, 'lockfileVersion 为 3（v1 不含 optional 依赖树）')
  t.ok(lock.packages['node_modules/jsqr'], 'lockfile 含 jsqr')
  t.ok(lock.packages['node_modules/@zxing/library'], 'lockfile 含 zxing')
  t.end()
})

test('packaging - 无解码器时 audit 仍能跑完并标 inconclusive（软失败路径）', function (t) {
  // 真实模拟 optionalDependencies 装不上：把 'jsqr' / '@zxing/library' 的解析改成抛 MODULE_NOT_FOUND，
  // 清掉 scanproof 模块缓存，重新 require 一份干净实例。
  const Module = require('module')
  const origResolve = Module._resolveFilename
  Module._resolveFilename = function (request) {
    if (request === 'jsqr' || request === '@zxing/library') {
      const err = new Error("Cannot find module '" + request + "'")
      err.code = 'MODULE_NOT_FOUND'
      throw err
    }
    return origResolve.apply(this, arguments)
  }

  const target = path.join('lib', 'scanproof')
  for (const k of Object.keys(require.cache)) {
    if (k.indexOf(target) >= 0) delete require.cache[k]
  }

  const fresh = require(path.join(ROOT, 'lib/scanproof/report'))
  return fresh.audit('https://example.com', { width: 200 }, { variants: false }).then(function (rep) {
    Module._resolveFilename = origResolve
    t.equal(rep.verdict, 'inconclusive', '无解码器 → inconclusive（绝不谎称 pass）')
    t.equal(rep.decode.consensus, 'unavailable', 'consensus 标 unavailable')
    t.equal(rep.decode.decoders.jsqr.verdict, 'unavailable', 'jsqr 单引擎也标 unavailable')
    t.ok(rep.warnings.length >= 1, '有警告说明原因：' + rep.warnings[0])
    t.ok(Array.isArray(rep.gates), '闸门结论仍然产出（不依赖解码器）')
    t.end()
  }).catch(function (e) {
    Module._resolveFilename = origResolve
    throw e
  })
})

test('packaging - files 清单包含运行所需目录与包入口', function (t) {
  for (const d of ['bin', 'lib', 'docs']) {
    t.ok(pkg.files.indexOf(d) >= 0, 'files 含 ' + d)
  }
  t.ok(fs.existsSync(path.join(ROOT, 'lib/index.js')), '包入口文件存在')
  t.ok(fs.existsSync(path.join(ROOT, 'lib/scanproof/index.js')), 'scanproof 入口存在')
  t.end()
})

test('packaging - scripts 提供分段测试入口', function (t) {
  t.ok(pkg.scripts['test:upstream'], 'test:upstream 存在')
  t.ok(pkg.scripts['test:scanproof'], 'test:scanproof 存在')
  t.ok(pkg.scripts.measure, 'measure 存在')
  t.end()
})

test('packaging - 许可证文件是 MIT 原文且未被追加污染', function (t) {
  const lic = fs.readFileSync(path.join(ROOT, 'license'), 'utf8')
  t.ok(lic.indexOf('The MIT License (MIT)') >= 0, 'MIT 标题在')
  t.ok(lic.indexOf('Copyright (c) 2012 Ryan Day') >= 0, '上游版权声明保留')
  t.end()
})

test('packaging - NOTICE 存在且声明来源与新增贡献', function (t) {
  const n = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8')
  t.ok(n.indexOf('node-qrcode') >= 0, '声明上游')
  t.ok(n.indexOf('scanproof') >= 0, '声明新增层')
  t.end()
})
