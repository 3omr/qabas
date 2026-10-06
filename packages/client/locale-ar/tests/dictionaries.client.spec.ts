/** Arabic product copy covers discovered feature dictionaries and preserves interpolation fields. */
import { globSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { dictionaries } from '../src/client/locales.ts'

function namespaceOf(source: ts.SourceFile): string | undefined {
  let namespace: string | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'LocaleNamespaceMap') {
      const member = node.members[0]
      if (member !== undefined && ts.isPropertySignature(member) && member.name !== undefined) {
        namespace = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return namespace ?? /export const NS = '([^']+)'/u.exec(source.text)?.[1] ?? /`([\w.-]+)` namespace/u.exec(source.text)?.[1]
}

const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/gu)].map(match => match[1] ?? '').sort()
const paths = globSync('packages/client/*/src/client/locales.ts', { cwd: process.cwd() }).filter(path => !path.includes('/locale-ar/'))

it('covers every feature namespace with Arabic text and the same interpolation fields', async () => {
  expect(paths.length).toBeGreaterThan(35)
  let inspected = 0
  for (const path of paths) {
    const source = ts.createSourceFile(path, readFileSync(join(process.cwd(), path), 'utf8'), ts.ScriptTarget.Latest, true)
    const entry = readFileSync(join(process.cwd(), dirname(path), 'index.ts'), 'utf8')
    const namespace = namespaceOf(source) ?? /const NS = '([^']+)'/u.exec(entry)?.[1] ?? /locale.register\('([^']+)'/u.exec(entry)?.[1]
    const { en: english } = await import(pathToFileURL(join(process.cwd(), path)).href) as { en: Record<string, string> }
    expect(namespace, path).toBeDefined()
    expect(Object.keys(english).length, path).toBeGreaterThan(0)
    const arabic = dictionaries[namespace ?? '']
    for (const [key, text] of Object.entries(english)) {
      const value = arabic?.[key]
      expect.soft(value, `${namespace}.${key}`).toBeTypeOf('string')
      expect.soft(value?.trim(), `${namespace}.${key}`).not.toBe('')
      expect.soft(placeholders(value ?? ''), `${namespace}.${key}`).toEqual(placeholders(text))
    }
    inspected++
  }
  expect(inspected).toBe(paths.length)
})
