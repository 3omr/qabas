/**
 * Reject product UI copy embedded directly in Client source.
 *
 * Locale dictionaries are the only source files allowed to own translated
 * text. Presentation code receives copy through its typed `t` seat or through
 * an already-localized prop. This check covers JSX text and copy-bearing
 * attributes, plus the common data/helper forms that feed them.
 */

import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const MINIMUM_CLIENT_UI_SOURCES = 450

const COPY_ATTRIBUTES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-valuetext',
  'cancelLabel',
  'closeLabel',
  'confirmLabel',
  'copyLabel',
  'description',
  'emptyLabel',
  'label',
  'placeholder',
  'title',
  'truncatedLabel',
])
const COPY_ATTRIBUTE_SUFFIX = /(?:Aria|Copy|Description|Heading|Label|Message|Placeholder|Summary|Text|Title|Tooltip)$/

const COPY_NAME = /(?:^|_)(?:aria|copy|description|empty|heading|label|message|placeholder|summary|text|title|tooltip)(?:s|_.*)?$/i
const COPY_SUFFIX = /(?:aria|copy|description|empty|heading|label|labels|message|placeholder|summary|text|title|tooltip|tabs)$/i
const IMMUTABLE_LANGUAGE_TOKENS = new Set([
  'B',
  'Function',
  'GB',
  'K',
  'KB',
  'M',
  'MB',
  'Symbol',
  'false',
  'function()',
  'n',
  'null',
  'true',
  'undefined',
])
const LOCALE_KEY = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)+$/

/** One hard-coded product-copy occurrence. */
export interface UiI18nViolation {
  /** One-based source column. */
  column: number
  /** Repository-relative source path. */
  file: string
  /** One-based source line. */
  line: number
  /** Why this literal is treated as product copy. */
  reason: string
  /** Compact literal text for the diagnostic. */
  text: string
}

function localeOwner(file: string): boolean {
  const normalized = file.replaceAll('\\', '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return base === 'locale.ts'
    || base === 'locales.ts'
    || normalized.includes('/locales/')
}

function containsProductText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized !== ''
    && !IMMUTABLE_LANGUAGE_TOKENS.has(normalized)
    && !LOCALE_KEY.test(normalized)
    && /\p{L}/u.test(normalized)
}

function propertyName(node: ts.PropertyName | ts.BindingName): string | undefined {
  return ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined
}

function copyAttribute(name: string): boolean {
  return !name.endsWith('Key')
    && (COPY_ATTRIBUTES.has(name) || COPY_ATTRIBUTE_SUFFIX.test(name))
}

function compactText(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`
}

function looksLikeNaturalText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return /\s|[\u3400-\u9fff]/u.test(normalized) || /^[A-Z]/.test(normalized)
}

/**
 * Find hard-coded product copy in one Client source file.
 * @param file - repository-relative path used in diagnostics.
 * @param sourceText - TypeScript or TSX source.
 * @returns violations in source order.
 */
export function findUiI18nViolations(file: string, sourceText: string): UiI18nViolation[] {
  if (localeOwner(file)) return []
  const source = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  )
  const violations = new Map<number, UiI18nViolation>()

  const report = (
    node: ts.Node,
    text: string,
    reason: string,
    naturalOnly = false,
  ): void => {
    if (
      !containsProductText(text)
      || (naturalOnly && !looksLikeNaturalText(text))
      || violations.has(node.getStart(source))
    ) return
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    violations.set(node.getStart(source), {
      column: position.character + 1,
      file,
      line: position.line + 1,
      reason,
      text: compactText(text),
    })
  }

  const collectExpression = (
    node: ts.Expression,
    reason: string,
    naturalOnly = false,
  ): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      report(node, node.text, reason, naturalOnly)
      return
    }
    if (ts.isTemplateExpression(node)) {
      report(
        node,
        [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(''),
        reason,
        naturalOnly,
      )
      return
    }
    if (ts.isCallExpression(node)) {
      // A call result is dynamic; copy-bearing arguments are visited through their own syntax.
      return
    }
    if (
      ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isSatisfiesExpression(node)
      || ts.isNonNullExpression(node)
    ) {
      collectExpression(node.expression, reason, naturalOnly)
      return
    }
    if (ts.isConditionalExpression(node)) {
      collectExpression(node.whenTrue, reason, naturalOnly)
      collectExpression(node.whenFalse, reason, naturalOnly)
      return
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        collectExpression(node.right, reason, naturalOnly)
      } else if (
        node.operatorToken.kind === ts.SyntaxKind.PlusToken
        || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        collectExpression(node.left, reason, naturalOnly)
        collectExpression(node.right, reason, naturalOnly)
      }
      return
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (ts.isExpression(element)) collectExpression(element, reason, naturalOnly)
      }
      return
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          const name = propertyName(property.name)
          const propertyOwnsCopy = name !== undefined
            && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))
          collectExpression(property.initializer, reason, naturalOnly || !propertyOwnsCopy)
        }
      }
    }
  }

  const enclosingFunctionName = (node: ts.Node): string | undefined => {
    let current = node.parent
    while (!ts.isSourceFile(current)) {
      if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) {
        return current.name === undefined ? undefined : propertyName(current.name)
      }
      if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        const parent = current.parent
        return ts.isVariableDeclaration(parent) ? propertyName(parent.name) : undefined
      }
      current = current.parent
    }
    return undefined
  }

  const hasExplicitStringReturn = (node: ts.Node): boolean => {
    let current = node.parent
    while (!ts.isSourceFile(current)) {
      if (
        ts.isFunctionDeclaration(current)
        || ts.isMethodDeclaration(current)
        || ts.isArrowFunction(current)
        || ts.isFunctionExpression(current)
      ) return current.type?.kind === ts.SyntaxKind.StringKeyword
      current = current.parent
    }
    return false
  }

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) report(node, node.text, 'JSX text')

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source)
      if (copyAttribute(name) && node.initializer !== undefined) {
        if (ts.isStringLiteral(node.initializer)) report(node.initializer, node.initializer.text, `${name} attribute`)
        else if (ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined) {
          collectExpression(node.initializer.expression, `${name} attribute`)
        }
      }
    }

    if (
      ts.isJsxExpression(node)
      && node.expression !== undefined
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) collectExpression(node.expression, 'JSX child')

    if ((file.endsWith('.tsx') || file.startsWith('apps/desktop/')) && ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name)
      if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
        collectExpression(node.initializer, `${name} property`)
      }
    }

    if (file.startsWith('apps/desktop/') && ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && (node.left.name.text === 'textContent' || node.left.name.text === 'innerText')) {
      collectExpression(node.right, `${node.left.name.text} assignment`)
    }

    if (file.startsWith('apps/desktop/') && ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && (node.expression.name.text === 'setTitle' || node.expression.name.text === 'prompt')) {
      const copy = node.arguments[0]
      if (copy !== undefined) collectExpression(copy, `${node.expression.name.text} argument`)
    }

    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const name = propertyName(node.name)
      if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
        collectExpression(node.initializer, `${name} value`)
      }
    }

    if (ts.isBindingElement(node) && node.initializer !== undefined) {
      const name = propertyName(node.name)
      if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
        collectExpression(node.initializer, `${name} default value`)
      }
    }

    if (ts.isReturnStatement(node) && node.expression !== undefined) {
      const name = enclosingFunctionName(node)
      if (name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))) {
        collectExpression(node.expression, `${name} return value`)
      } else if (file.endsWith('.tsx') && hasExplicitStringReturn(node)) {
        collectExpression(node.expression, 'string return value', true)
      }
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...violations.values()].sort((left, right) => left.line - right.line || left.column - right.column)
}

/**
 * Resolve the normalized Client source root containing one TSX component.
 * @param file - Glob result using native or POSIX separators.
 * @returns Repository-relative `src/client` root, or undefined outside that tree.
 */
export function clientSourceRoot(file: string): string | undefined {
  const normalized = file.replaceAll('\\', '/')
  const marker = '/src/client/'
  const index = normalized.indexOf(marker)
  return index < 0 ? undefined : normalized.slice(0, index + marker.length - 1)
}

function sourceFiles(): string[] {
  const clientComponentRoots = new Set(
    globSync('packages/*/*/src/client/**/*.tsx', { cwd: root })
      .map(clientSourceRoot)
      .filter((clientRoot): clientRoot is string => clientRoot !== undefined),
  )
  return [...new Set([
    ...globSync('packages/client/*/src/**/*.tsx', { cwd: root }),
    ...globSync('packages/client/ui-*/src/**/*.{ts,tsx}', { cwd: root }),
    ...[...clientComponentRoots].flatMap(clientRoot =>
      globSync(`${clientRoot}/**/*.{ts,tsx}`, { cwd: root })),
    ...globSync('apps/web/src/**/*.{ts,tsx}', { cwd: root }),
    ...globSync('apps/desktop/src/{main,update-coordinator}.{ts,tsx}', { cwd: root }),
    ...globSync('apps/desktop/renderer/*.js', { cwd: root }),
  ])]
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => !file.endsWith('.d.ts'))
    .sort()
}


/**
 * Compare a language-pack dictionary with the English source keys and interpolation fields.
 * @param namespace - Locale namespace used in diagnostics.
 * @param english - English dictionary defining the keys.
 * @param arabic - Arabic dictionary supplied by the product pack.
 * @returns Missing, extra, empty, or incompatible translations.
 */
export function dictionaryParityProblems(
  namespace: string,
  english: Readonly<Record<string, string>>,
  arabic: Readonly<Record<string, string>> | undefined,
): string[] {
  const problems: string[] = []
  const fields = (value: string): string => [...value.matchAll(/\{(\w+)\}/gu)]
    .map(match => match[1]).sort().join(',')
  for (const [key, value] of Object.entries(english)) {
    const translation = arabic?.[key]
    if (translation === undefined || translation.trim() === '') problems.push(`${namespace}.${key}: missing Arabic text`)
    else if (fields(value) !== fields(translation)) problems.push(`${namespace}.${key}: interpolation fields differ`)
  }
  for (const key of Object.keys(arabic ?? {})) {
    if (!(key in english)) problems.push(`${namespace}.${key}: absent from English`)
  }
  return problems
}

/**
 * Read every shipped English dictionary and compare it with the Arabic pack.
 * @returns Discovery count and parity diagnostics.
 */
export function verifyDictionaryParity(): { count: number; problems: string[] } {
  const arabicFile = 'packages/client/locale-ar/src/client/locales.ts'
  const arabicSource = ts.createSourceFile(arabicFile, readFileSync(resolve(root, arabicFile), 'utf8'), ts.ScriptTarget.Latest, true)
  const arabicDictionaries: Record<string, Record<string, string>> = {}
  for (const statement of arabicSource.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(arabicSource) !== 'dictionaries') continue
      if (declaration.initializer === undefined || !ts.isObjectLiteralExpression(declaration.initializer)) {
        throw new Error(`${arabicFile}: Arabic dictionaries must be literal`)
      }
      for (const namespace of declaration.initializer.properties) {
        if (!ts.isPropertyAssignment(namespace) || !ts.isObjectLiteralExpression(namespace.initializer)) {
          throw new Error(`${arabicFile}: Arabic namespace must be literal`)
        }
        const name = propertyName(namespace.name)
        if (name === undefined) throw new Error(`${arabicFile}: Arabic namespace name must be literal`)
        const dictionary: Record<string, string> = {}
        for (const property of namespace.initializer.properties) {
          if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) {
            throw new Error(`${arabicFile}: Arabic entries must be literal text`)
          }
          const key = propertyName(property.name)
          if (key === undefined) throw new Error(`${arabicFile}: Arabic key must be literal`)
          dictionary[key] = property.initializer.text
        }
        arabicDictionaries[name] = dictionary
      }
    }
  }
  const paths = globSync('packages/*/*/src/**/{locale,locales,en,settings}.ts', { cwd: root })
    .filter(file => !file.includes('/locale-ar/'))
  const problems: string[] = []
  let count = 0
  for (const file of paths) {
    const source = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
    let namespace = file === 'packages/client/locale/src/locales/en.ts' ? 'common'
      : file === 'packages/client/locale/src/locales/settings.ts' ? 'settings.locale' : undefined
    let english: Record<string, string> | undefined
    const additional: { namespace: string; dictionary: Record<string, string> }[] = []
    const constants = new Map<string, ts.Expression>()
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
          constants.set(declaration.name.text, declaration.initializer)
        }
      }
    }
    const textValue = (expression: ts.Expression, seen = new Set<string>()): string => {
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text
      if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        return textValue(expression.left, seen) + textValue(expression.right, seen)
      }
      if (ts.isIdentifier(expression)) {
        const value = constants.get(expression.text)
        if (value !== undefined && !seen.has(expression.text)) {
          return textValue(value, new Set([...seen, expression.text]))
        }
      }
      throw new Error(`${file}: English entries must be literal text`)
    }
    const entries = (expression: ts.Expression, seen = new Set<string>()): Record<string, string> => {
      let literal = expression
      while (ts.isSatisfiesExpression(literal) || ts.isAsExpression(literal)) literal = literal.expression
      if (ts.isIdentifier(literal)) {
        const value = constants.get(literal.text)
        if (value === undefined || seen.has(literal.text)) throw new Error(`${file}: unresolvable dictionary spread`)
        return entries(value, new Set([...seen, literal.text]))
      }
      if (!ts.isObjectLiteralExpression(literal)) throw new Error(`${file}: English dictionary must be a literal`)
      const result: Record<string, string> = {}
      for (const property of literal.properties) {
        if (ts.isSpreadAssignment(property)) Object.assign(result, entries(property.expression, seen))
        else if (ts.isPropertyAssignment(property)) {
          const key = propertyName(property.name)
          if (key === undefined) throw new Error(`${file}: dictionary key must be literal`)
          result[key] = textValue(property.initializer)
        } else throw new Error(`${file}: English entries must be literal text`)
      }
      return result
    }
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === 'LocaleNamespaceMap') {
        const member = node.members[0]
        if (member !== undefined && ts.isPropertySignature(member)) namespace = propertyName(member.name)
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        if (node.name.text === 'NS' && node.initializer !== undefined && ts.isStringLiteral(node.initializer)) {
          namespace ??= node.initializer.text
        }
        if (node.initializer !== undefined) {
          if (node.name.text === 'en') english = entries(node.initializer)
          else if (node.name.text.endsWith('En')) {
            const owner = constants.get(`${node.name.text.slice(0, -2).toUpperCase()}_NS`)
            if (owner === undefined || !ts.isStringLiteral(owner)) {
              throw new Error(`${file}: ${node.name.text} has no namespace constant`)
            }
            additional.push({ namespace: owner.text, dictionary: entries(node.initializer) })
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (english === undefined) continue
    namespace ??= /`([\w.-]+)` namespace/u.exec(source.text)?.[1]
    if (namespace === undefined) {
      const entry = readFileSync(resolve(root, dirname(file), 'index.ts'), 'utf8')
      namespace = /const (?:[A-Z_]*NS) = '([^']+)'/u.exec(entry)?.[1]
        ?? /locale.register\('([^']+)'/u.exec(entry)?.[1]
    }
    if (namespace === undefined) throw new Error(`${file}: English dictionary has no locale namespace`)
    for (const pair of [{ namespace, dictionary: english }, ...additional]) {
      count++
      problems.push(...dictionaryParityProblems(pair.namespace, pair.dictionary, arabicDictionaries[pair.namespace]))
    }
  }
  if (count < 40) throw new Error(`locale parity discovery narrowed to ${count} dictionaries`)
  return { count, problems }
}

function main(): void {
  const parity = verifyDictionaryParity()
  if (parity.problems.length > 0) {
    for (const problem of parity.problems) console.error(problem)
    process.exitCode = 1
  }
  const files = sourceFiles()
  if (files.length < MINIMUM_CLIENT_UI_SOURCES) {
    throw new Error(
      `verify-client-ui-i18n: discovery narrowed to ${files.length} source file(s); expected at least ${MINIMUM_CLIENT_UI_SOURCES}.`,
    )
  }
  const violations = files.flatMap(file =>
    findUiI18nViolations(file, readFileSync(resolve(root, file), 'utf8')))
  if (violations.length > 0) {
    console.error(`verify-client-ui-i18n: ${violations.length} hard-coded UI string(s):`)
    for (const violation of violations) {
      console.error(
        `  ${violation.file}:${violation.line}:${violation.column} ${violation.reason}: ${JSON.stringify(violation.text)}`,
      )
    }
    process.exitCode = 1
    return
  }
  console.log(`verify-client-ui-i18n: ${files.length} Client UI source file(s) use locale-owned copy; ${parity.count} en/ar dictionaries checked.`)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
