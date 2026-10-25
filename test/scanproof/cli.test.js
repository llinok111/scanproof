const test = require('tap').test
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '../..')
const CLI = path.join(ROOT, 'bin/qr-scanproof')
const TEXT = 'https://example.com/order/12345'

function run (args) {
  return spawnSync(process.execPath, [CLI].concat(args), {
    cwd: ROOT,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { NODE_PATH: '' })
  })
}

test('cli - 默认参数退出码 0 且输出 Markdown', function (t) {
  const r = run([TEXT])
  t.equal(r.status, 0, '退出码 0，stderr=' + r.stderr.slice(0, 200))
  t.ok(r.stdout.indexOf('# ScanProof 报告') === 0, '有标题')
  t.ok(r.stdout.indexOf('PASS') >= 0, '含 PASS')
  t.end()
})

test('cli - margin=0 退出码 2（失败）', function (t) {
  const r = run([TEXT, '--margin', '0'])
  t.equal(r.status, 2, '退出码 2')
  t.ok(r.stdout.indexOf('FAIL') >= 0, '含 FAIL')
  t.end()
})

test('cli - 非整数缩放退出码 1（警告）', function (t) {
  const r = run([TEXT, '--width', '100'])
  t.equal(r.status, 1, '退出码 1')
  t.ok(r.stdout.indexOf('WARN') >= 0, '含 WARN')
  t.end()
})

test('cli - --json 输出可解析且与退出码一致', function (t) {
  const r = run([TEXT, '--margin', '0', '--json', '--no-variants'])
  t.equal(r.status, 2, '退出码 2')
  let rep
  t.doesNotThrow(function () { rep = JSON.parse(r.stdout) }, 'stdout 是合法 JSON')
  t.equal(rep.verdict, 'fail', 'JSON 里 verdict=fail')
  t.equal(rep.gates[0].id, 'quiet-zone', '第一个问题是静区')
  t.end()
})

test('cli - --no-decode 退出码 3（不确定）', function (t) {
  const r = run([TEXT, '--no-decode'])
  t.equal(r.status, 3, '退出码 3')
  t.ok(r.stdout.indexOf('INCONCLUSIVE') >= 0, '含 INCONCLUSIVE')
  t.end()
})

test('cli - 缺少文本参数时非零退出并给出用法', function (t) {
  const r = run([])
  t.equal(r.status, 2, '退出码 2')
  t.ok(/缺少待编码文本/.test(r.stderr), 'stderr 有提示')
  t.end()
})

test('cli - --suggest 列出候选且采纳项严格变好', function (t) {
  const r = run([TEXT, '--margin', '0', '--suggest', '--no-variants'])
  t.equal(r.status, 0, '修复后应为 0，实得 ' + r.status)
  t.ok(/把静区补到 4 模块/.test(r.stdout), '列出 margin 方案')
  t.ok(/fail → pass/.test(r.stdout), '显示结论变化')
  t.end()
})

test('cli - --suggest --write 真的写出可验收的 PNG', function (t) {
  const out = path.join(os.tmpdir(), 'scanproof-cli-write-' + process.pid + '.png')
  if (fs.existsSync(out)) fs.unlinkSync(out)
  const r = run([TEXT, '--margin', '0', '--suggest', '--write', out, '--no-variants'])
  t.equal(r.status, 0, '退出码 0')
  t.ok(fs.existsSync(out), '文件已写出')
  const check = run(['--file', out])
  t.equal(check.status, 0, '写出的文件验收通过')
  if (fs.existsSync(out)) fs.unlinkSync(out)
  t.end()
})

test('cli - --file 对已存在 PNG 验收', function (t) {
  const tmp = path.join(os.tmpdir(), 'scanproof-cli-file-' + process.pid + '.png')
  const w = spawnSync(process.execPath, ['-e',
    'require(' + JSON.stringify(path.join(ROOT, 'lib/index').replace(/\\/g, '/')) + ').toFile(' +
    JSON.stringify(tmp) + ',' + JSON.stringify(TEXT) + ',{type:"png"})'
  ], { cwd: ROOT, encoding: 'utf8' })
  t.equal(w.status, 0, '前置生成成功')
  const r = run(['--file', tmp])
  t.equal(r.status, 0, '验收退出码 0')
  t.ok(r.stdout.indexOf(TEXT) >= 0, '报告里给出读出的原文')
  fs.unlinkSync(tmp)
  t.end()
})

test('cli - stdout 管道不被截断（大 JSON 完整）', function (t) {
  const r = run([TEXT, '--json'])
  t.equal(r.status, 0, '退出码 0')
  let parsed = null
  t.doesNotThrow(function () { parsed = JSON.parse(r.stdout) }, '完整 JSON（' + r.stdout.length + ' 字节）')
  t.ok(parsed && parsed.variants.length > 0, '含变体结果')
  t.end()
})
