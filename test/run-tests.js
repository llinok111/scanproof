// Windows(msys) 下的上游测试入口：node_modules/.bin/tap 是 sh 脚本，Windows 不可直接 exec。
// 这里用 module._initPaths 注入 NODE_PATH，再调用 tap 的 run.js。
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const env = Object.assign({}, process.env, {
  NODE_PATH: [root, path.join(root, 'lib')].join(path.delimiter)
})
const patterns = process.argv.slice(2)
if (!patterns.length) patterns.push('test/unit/**/*.test.js', 'test/e2e/**/*.test.js')

const r = spawnSync(process.execPath, [path.join(root, 'node_modules/tap/bin/run.js'), '--no-coverage'].concat(patterns), {
  cwd: root,
  env,
  stdio: 'inherit'
})
process.exit(r.status === null ? 1 : r.status)
