'use strict'

/**
 * 构建浏览器演示包
 *
 * 产物 demo/scanproof.bundle.js 是一个 IIFE，暴露 window.ScanProof。
 * 之所以单独写脚本而不塞进上游 rollup.config.js：上游那份配置的职责是产出
 * lib 的 UMD/ESM 分发文件，属于"库分发"；这里是"演示站点"，两者生命周期不同，
 * 混在一起会让 `npm run build` 的语义变模糊。
 */

const path = require('path')
const { rollup } = require('rollup')
const resolve = require('@rollup/plugin-node-resolve')
const commonjs = require('@rollup/plugin-commonjs')
const { terser } = require('rollup-plugin-terser')

const ROOT = path.join(__dirname, '..')

async function main () {
  const bundle = await rollup({
    input: path.join(ROOT, 'demo/app.js'),
    plugins: [
      resolve({ browser: true, preferBuiltins: false }),
      commonjs({ transformMixedEsModules: true }),
      // 上游锁的 terser 版本不支持 format 选项，用默认压缩即可
      terser()
    ],
    onwarn (warning, warn) {
      // zxing 内部有若干 "this is undefined" 类的无害告警
      if (warning.code === 'THIS_IS_UNDEFINED') return
      if (warning.code === 'CIRCULAR_DEPENDENCY') return
      warn(warning)
    }
  })

  const out = path.join(ROOT, 'demo/scanproof.bundle.js')
  await bundle.write({
    file: out,
    format: 'iife',
    name: 'ScanProof',
    sourcemap: false
  })
  await bundle.close()

  const fs = require('fs')
  const size = fs.statSync(out).size
  process.stdout.write('demo/scanproof.bundle.js  ' + (size / 1024).toFixed(1) + ' KiB\n')
}

main().catch((e) => {
  process.stderr.write((e && e.stack ? e.stack : String(e)) + '\n')
  process.exitCode = 1
})
