'use strict'

/**
 * scanproof 公共 API
 *
 * 定位：node-qrcode 的**验收层**，不是替代品。
 * 生成仍然走上游（`require('qrcode')`），本模块只回答"这份产物能不能扫"。
 *
 * 用法：
 *   const { audit, auditBuffer } = require('qrcode/lib/scanproof')
 *   const report = await audit('https://example.com', { errorCorrectionLevel: 'M' })
 *   if (report.verdict !== 'pass') console.log(report.gates)
 */

const report = require('./report')
const suggest = require('./suggest')
const decoder = require('./decoder')
const geometry = require('./geometry')
const { VARIANTS } = require('./variants')

module.exports = {
  audit: report.audit,
  auditBuffer: require('./buffer').auditBuffer,
  suggest: suggest.suggest,
  applySuggestions: suggest.applySuggestions,
  renderToText: report.renderText,
  decodersAvailable: decoder.available,
  geometry,
  VARIANTS,
  SCHEMA: report.SCHEMA
}
