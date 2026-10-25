'use strict'

/**
 * 版本号常量。
 *
 * 为什么不直接 `require('../../package.json')`：
 *   1. 报告要在浏览器里生成，打包器解析 JSON 需要额外插件；
 *   2. 运行时不读文件系统，避免打包/打包后路径差异导致的隐性失败。
 *
 * 代价是"可能与 package.json 不一致"，所以 test/scanproof/packaging.test.js
 * 里有一条断言专门锁死两者相等 —— 这条测试存在的意义就是防止版本漂移。
 */
module.exports = '2.0.0'
