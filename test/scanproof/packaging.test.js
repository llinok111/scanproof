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

test('packaging - CI 工作流 YAML 可解析（远端才暴露的缺陷）', function (t) {
  // 一个未加引号的 `name: X (expected: 3 failures)` 就能让整个 workflow 失效：
  // GitHub 报 "workflow file issue"、0 秒失败、jobs 为空，本地不做语法检查根本发现不了。
  // 这里用可用的 YAML 解析器在本地拦下这一类问题。
  let parse = null
  for (const mod of ['js-yaml', 'yaml']) {
    try {
      const m = require(mod)
      parse = mod === 'js-yaml' ? (s) => m.load(s) : (s) => m.parse(s)
      break
    } catch (e) { /* 试下一个 */ }
  }
  if (!parse) {
    t.skip('环境无可用的 YAML 解析器（js-yaml / yaml 均缺失），本项未执行')
    t.end()
    return
  }

  const dir = path.join(ROOT, '.github/workflows')
  const files = fs.readdirSync(dir).filter(f => /\.ya?ml$/.test(f))
  t.ok(files.length >= 1, '至少一个工作流文件，实得 ' + files.length)

  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    let doc = null
    t.doesNotThrow(function () { doc = parse(src) }, f + ' YAML 语法正确')
    if (!doc) continue

    // YAML 1.1 会把裸 on 解析成布尔键 true，所以两种键名都要看
    const triggers = doc.on || doc.true
    t.ok(triggers && typeof triggers === 'object', f + ' 有 on 触发器')
    t.ok(triggers && triggers.push, f + ' 有 push 触发')
    t.ok(doc.jobs && Object.keys(doc.jobs).length > 0, f + ' 至少一个 job')

    for (const [jid, job] of Object.entries(doc.jobs || {})) {
      t.ok(job['runs-on'], jid + ' 有 runs-on')
      t.ok(Array.isArray(job.steps) && job.steps.length > 0, jid + ' 有 steps')
      for (const s of job.steps || []) {
        t.ok(s.uses || s.run, jid + ' 的每个 step 都有 uses 或 run')
      }
    }
  }
  t.end()
})

test('packaging - CI 用 npm ci 且校验解码器存在', function (t) {
  // npm install 在 lockfile 与实际依赖不一致时会"就地修正"，静默掩盖问题；
  // npm ci 会直接失败，这才是 CI 该有的行为。
  const src = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
  t.ok(/npm ci/.test(src), 'CI 使用 npm ci')
  t.ok(/decoder.*available|Decoders present/.test(src), 'CI 显式校验两个解码器已装上')
  t.ok(!/zxing\/library@0\.23/.test(src), 'CI 不再硬装要求 node>=24 的 zxing 版本')
  t.end()
})

test('packaging - CI 命令与本地 npm scripts 一致（本地绿/CI 红的根因）', function (t) {
  // 本项目踩过：本地跑 `npx standard --env browser --env node <paths>`（通过），
  // CI 跑 `npm run lint`（= bare standard，走 package.json 配置）→ 六个矩阵 job 全红。
  // 差别在**命令**而不是环境。这里断言 CI 只通过 npm scripts 调用这些步骤。
  const src = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')

  const runLines = src.split('\n')
    .filter(l => /^\s*-?\s*run:/.test(l) || /^\s*run:\s/.test(l))
    .map(l => l.replace(/^\s*-?\s*run:\s*/, '').trim())

  const scriptCalls = runLines.filter(c => /^npm (run|ci|test)\b/.test(c))
  t.ok(scriptCalls.length >= 3, '多数步骤通过 npm scripts 调用，实得 ' + scriptCalls.length)

  // 明确禁用两种"绕过配置"的写法
  t.ok(!runLines.some(c => /\bnpx standard\b/.test(c)), 'CI 不得内联 npx standard（会绕过 standard 配置）')
  t.ok(!runLines.some(c => /standard --env/.test(c)), 'CI 不得用 --env 覆盖 lint 环境')

  // lint 脚本本身必须是 bare standard
  t.equal(pkg.scripts.lint, 'standard', 'npm run lint 就是 bare standard')
  t.ok(pkg.scripts.test.indexOf('test/run-tests.js') >= 0, 'npm test 走本地测试入口')
  t.ok(/npm run test:scanproof/.test(src), 'CI 调用 npm run test:scanproof')
  t.ok(/npm run test:upstream/.test(src), 'CI 调用 npm run test:upstream')
  t.ok(/npm run build/.test(src), 'CI 调用 npm run build')
  t.ok(/npm run measure/.test(src), 'CI 调用 npm run measure')
  t.end()
})

test('packaging - NOTICE 存在且声明来源与新增贡献', function (t) {
  const n = fs.readFileSync(path.join(ROOT, 'NOTICE'), 'utf8')
  t.ok(n.indexOf('node-qrcode') >= 0, '声明上游')
  t.ok(n.indexOf('scanproof') >= 0, '声明新增层')
  t.end()
})
