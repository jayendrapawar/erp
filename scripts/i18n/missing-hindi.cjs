// Lists English UI text in app/, components/ and lib/ that has no entry in lib/i18n/hi.json.
// Run after adding screens or messages:  node scripts/i18n/missing-hindi.cjs
// Some hits are not UI text (CSS, file names, print templates); ignore those.
const fs = require('fs')
const path = require('path')
const repo = path.resolve(__dirname, '../..')
const ts = require(path.join(repo, 'node_modules/typescript'))

const files = []
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) { if (!['node_modules', '.next', 'ui'].includes(e.name)) walk(p) }
    else if (/\.(tsx|ts)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p)
  }
}
for (const d of ['app', 'components', 'lib']) walk(path.join(repo, d))

const SKIP_ATTR = new Set(['className', 'href', 'src', 'type', 'name', 'id', 'key', 'variant', 'size', 'method', 'accept', 'autoComplete', 'inputMode', 'role', 'value', 'defaultValue', 'htmlFor', 'rel', 'target', 'mode', 'side', 'align', 'pattern', 'lang', 'dir', 'style', 'viewBox', 'd', 'fill', 'stroke', 'dataKey', 'capture', 'encType', 'orientation'])
const MSG_PROPS = new Set(['label', 'description', 'title', 'message', 'error', 'placeholder', 'hint', 'subtitle', 'text', 'reason', 'detail', 'warning', 'note', 'help', 'empty', 'confirm', 'heading', 'tip', 'info'])
const MSG_CALLS = new Set(['Error', 'setError', 'setMsg', 'setMessage', 'setWarn', 'setWarnMsg', 'setSuccessMsg', 'setNotice', 'toast', 'alert', 'confirm', 'fail', 'showError', 'showSuccess', 'showWarn', 'setStatus', 'setInfo', 'flash', 'notify', 'err', 'bad', 'reject'])

const out = new Map() // text -> Set(files)
function add(s, file) {
  s = s.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&(nbsp|thinsp);/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (!/[A-Za-z]{2}/.test(s)) return
  if (/^[a-z][\w.-]*$/.test(s) && !/^(ok|yes|no)$/.test(s)) return // identifiers / css keywords
  if (/^(use client|use server)$/.test(s)) return
  if (/^[\w-]+(\s[\w:/\[\]().-]+)*$/.test(s) && /(^|\s)(flex|grid|text-|bg-|px-|py-|w-|h-|rounded|border|items-|justify-|gap-|mt-|mb-|p-\d)/.test(s)) return
  if (/^(https?:|\/|@\/|\.\/|[a-z]+\/)/.test(s)) return
  if (/^[A-Z0-9_]+$/.test(s)) return // CONSTANTS
  if (!out.has(s)) out.set(s, new Set())
  out.get(s).add(path.relative(repo, file).replace(/\\/g, '/'))
}
function tpl(node) { // template literal -> "text {0} text"
  let s = node.head.text, i = 0
  for (const sp of node.templateSpans) s += `{${i++}}` + sp.literal.text
  return s
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const isTsx = file.endsWith('.tsx')
  const rel = path.relative(repo, file).replace(/\\/g, '/')
  const serverMsgsOnly = !isTsx // .ts files: only error/message strings
  if (/^lib\/(db|qr-config|translations|auth|permissions)/.test(rel) || rel.startsWith('lib/db/')) continue
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  function strOf(n) {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
    if (ts.isTemplateExpression(n)) return tpl(n)
    return null
  }
  function inSkippedAttr(n) {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isJsxAttribute(p)) return SKIP_ATTR.has(p.name.getText()) || /^(on[A-Z]|data-)/.test(p.name.getText()) && !/^aria-/.test(p.name.getText())
      if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true
      if (ts.isCallExpression(p) && /^(cn|clsx|cva|twMerge|require|import|fetch|router\.push|redirect|revalidatePath|sql|eq|getSetting|setSetting|localStorage\.\w+|console\.\w+|searchParams\.get|headers\.get|new Date)$/.test(p.expression.getText())) return true
      if (ts.isPropertyAssignment(p) && /^(className|cls|color|border|href|icon|tone|key|id|variant|dataKey|value|status|kind|role|permission)$/.test(p.name.getText())) return true
      if (ts.isElementAccessExpression(p) || ts.isCaseClause(p)) return true
      if (ts.isBinaryExpression(p) && /^(===|!==|==|!=)$/.test(p.operatorToken.getText())) return true
      if (ts.isTypeNode && ts.isTypeNode(p)) return true
    }
    return false
  }
  function msgContext(n) { // for .ts: string used as a message
    for (let p = n.parent, depth = 0; p && depth < 4; p = p.parent, depth++) {
      if (ts.isPropertyAssignment(p) && MSG_PROPS.has(p.name.getText())) return true
      if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && MSG_CALLS.has(p.expression.getText().split('.').pop())) return true
      if (ts.isReturnStatement(p) || ts.isThrowStatement(p)) return false
    }
    return false
  }
  function visit(n) {
    if (isTsx && ts.isJsxText(n)) add(n.text, file)
    else {
      const s = strOf(n)
      if (s != null) {
        if (serverMsgsOnly) { if (msgContext(n)) add(s, file) }
        else if (!inSkippedAttr(n)) add(s, file)
        if (ts.isTemplateExpression(n)) return // spans handled via text
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
}
const book = JSON.parse(fs.readFileSync(path.join(repo, 'lib/i18n/hi.json'), 'utf8'))
const missing = [...out.entries()].filter(([t]) => !(t in book)).sort((a, b) => [...a[1]][0].localeCompare([...b[1]][0]))
for (const [t, f] of missing) console.log([...f][0] + ' | ' + t)
console.log(`\n${missing.length} phrase(s) without Hindi`)
