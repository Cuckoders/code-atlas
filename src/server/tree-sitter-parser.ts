import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  KOTLIN_GRAMMAR,
  KOTLIN_GRAMMAR_WASM_SPECIFIER,
} from '@binclusive/tree-sitter-kotlin-wasm';
import { Language, Parser, type Node as SyntaxNode } from 'web-tree-sitter';
import type { NodeKind, SymbolMember } from '../shared/graph.js';

export interface ParsedSource {
  symbols: Array<{
    name: string;
    kind: NodeKind;
    line: number;
    members: SymbolMember[];
  }>;
  imports: string[];
  calls: Array<{
    sourceSymbol: string;
    targetSymbol: string;
    targetMember?: string;
    importSpecifier?: string;
    line: number;
  }>;
  namespace?: string;
  routes: SymbolMember[];
  parser: string;
}

interface GrammarConfig {
  name: string;
  wasm: string;
  sha256?: string;
  declarationTypes: Set<string>;
  interfaceTypes: Set<string>;
  functionTypes: Set<string>;
  methodTypes: Set<string>;
  importTypes: Set<string>;
}

const GRAMMARS: Record<string, GrammarConfig> = {
  '.java': config('java', ['class_declaration', 'record_declaration', 'enum_declaration'], ['interface_declaration', 'annotation_type_declaration'], ['method_declaration'], ['method_declaration', 'constructor_declaration'], ['import_declaration']),
  '.go': config('go', ['type_spec'], ['interface_type'], ['function_declaration'], ['method_declaration'], ['import_spec']),
  '.rs': config('rust', ['struct_item', 'enum_item', 'union_item'], ['trait_item'], ['function_item'], ['function_item'], ['use_declaration']),
  '.cs': config('c-sharp', ['class_declaration', 'record_declaration', 'struct_declaration', 'enum_declaration'], ['interface_declaration'], ['global_statement'], ['method_declaration', 'constructor_declaration'], ['using_directive']),
  '.php': config('php', ['class_declaration', 'trait_declaration', 'enum_declaration'], ['interface_declaration'], ['function_definition'], ['method_declaration'], ['namespace_use_declaration']),
  '.kt': config('kotlin', ['class_declaration', 'object_declaration'], [], ['function_declaration'], ['function_declaration', 'secondary_constructor'], ['import'], KOTLIN_GRAMMAR_WASM_SPECIFIER, KOTLIN_GRAMMAR.sha256),
  '.kts': config('kotlin', ['class_declaration', 'object_declaration'], [], ['function_declaration'], ['function_declaration', 'secondary_constructor'], ['import'], KOTLIN_GRAMMAR_WASM_SPECIFIER, KOTLIN_GRAMMAR.sha256),
};

const require = createRequire(import.meta.url);
const configuredWasmDirectory = process.env.CODE_ATLAS_WASM_DIR;
if (configuredWasmDirectory && !path.isAbsolute(configuredWasmDirectory)) {
  throw new Error('CODE_ATLAS_WASM_DIR must be absolute');
}
const coreWasmPath = configuredWasmDirectory
  ? path.join(configuredWasmDirectory, 'web-tree-sitter.wasm')
  : require.resolve('web-tree-sitter/web-tree-sitter.wasm');
let parserInitialization: Promise<void> | undefined;
const languageCache = new Map<string, Promise<Language>>();

export async function parseWithTreeSitter(extension: string, content: string): Promise<ParsedSource | null> {
  const grammar = GRAMMARS[extension];
  if (!grammar) return null;

  await initializeParser();
  const language = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(content);
  if (!tree) {
    parser.delete();
    return null;
  }

  try {
    return extractSource(tree.rootNode, grammar);
  } finally {
    tree.delete();
    parser.delete();
  }
}

function config(
  name: string,
  declarationTypes: string[],
  interfaceTypes: string[],
  functionTypes: string[],
  methodTypes: string[],
  importTypes: string[],
  wasm = `@vscode/tree-sitter-wasm/wasm/tree-sitter-${name}.wasm`,
  sha256?: string,
): GrammarConfig {
  return {
    name,
    wasm,
    ...(sha256 ? { sha256 } : {}),
    declarationTypes: new Set(declarationTypes),
    interfaceTypes: new Set(interfaceTypes),
    functionTypes: new Set(functionTypes),
    methodTypes: new Set(methodTypes),
    importTypes: new Set(importTypes),
  };
}

function initializeParser(): Promise<void> {
  parserInitialization ??= Parser.init({ locateFile: () => coreWasmPath });
  return parserInitialization;
}

function loadLanguage(grammar: GrammarConfig): Promise<Language> {
  let language = languageCache.get(grammar.name);
  if (!language) {
    language = loadVerifiedLanguage(grammar);
    languageCache.set(grammar.name, language);
  }
  return language;
}

async function loadVerifiedLanguage(grammar: GrammarConfig): Promise<Language> {
  const wasmPath = configuredWasmDirectory
    ? path.join(configuredWasmDirectory, `tree-sitter-${grammar.name}.wasm`)
    : require.resolve(grammar.wasm);
  if (!grammar.sha256) return Language.load(wasmPath);
  const bytes = await fs.readFile(wasmPath);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== grammar.sha256) throw new Error(`Tree-sitter ${grammar.name} grammar digest mismatch`);
  return Language.load(bytes);
}

function extractSource(root: SyntaxNode, grammar: GrammarConfig): ParsedSource {
  const symbols: ParsedSource['symbols'] = [];
  const imports: string[] = [];
  const seen = new Set<string>();

  function visit(node: SyntaxNode, insideType = false): void {
    if (grammar.importTypes.has(node.type)) {
      const importPath = extractImport(node);
      if (importPath) imports.push(importPath);
      return;
    }

    if (grammar.declarationTypes.has(node.type) || grammar.interfaceTypes.has(node.type)) {
      const typeNode = normalizeGoTypeNode(node, grammar);
      const name = getNodeName(typeNode);
      if (name) {
        const members = collectMembers(typeNode, grammar);
        addSymbol(symbols, seen, {
          name,
          kind: isInterfaceNode(typeNode, grammar)
            ? 'interface'
            : /Controller$/.test(name) ? 'controller' : 'class',
          line: typeNode.startPosition.row + 1,
          members,
        });
      }
      if (grammar.name === 'go' && node.type === 'type_spec') return;
      return;
    }

    if (!insideType && grammar.functionTypes.has(node.type)) {
      const name = getNodeName(node);
      if (name && name !== 'global') {
        addSymbol(symbols, seen, {
          name,
          kind: 'function',
          line: node.startPosition.row + 1,
          members: [],
        });
      }
    }

    const nextInsideType = insideType || isTypeContainer(node.type, grammar);
    for (const child of node.namedChildren) visit(child, nextInsideType);
  }

  visit(root);
  attachRustImplMethods(root, grammar, symbols);
  attachGoMethods(root, grammar, symbols);
  const uniqueImports = [...new Set(imports)];

  return {
    symbols,
    imports: uniqueImports,
    calls: collectCalls(root, grammar, uniqueImports),
    namespace: extractNamespace(root.text, grammar.name),
    routes: [],
    parser: `Tree-sitter WASM · ${grammar.name}`,
  };
}

const MAX_CALLS_PER_FILE = 5_000;
const CALL_NODE_TYPES: Record<string, Set<string>> = {
  java: new Set(['method_invocation', 'object_creation_expression']),
  go: new Set(['call_expression']),
  rust: new Set(['call_expression']),
  'c-sharp': new Set(['invocation_expression', 'object_creation_expression']),
  php: new Set(['function_call_expression', 'member_call_expression', 'scoped_call_expression', 'object_creation_expression']),
  kotlin: new Set(['call_expression']),
};

function collectCalls(
  root: SyntaxNode,
  grammar: GrammarConfig,
  imports: string[],
): ParsedSource['calls'] {
  const calls: ParsedSource['calls'] = [];
  const seen = new Set<string>();
  const importBindings = createImportBindings(root.text, imports, grammar.name);
  const variableTypes = collectVariableTypes(root.text, grammar.name);
  const callTypes = CALL_NODE_TYPES[grammar.name] ?? new Set<string>();

  function add(
    sourceSymbol: string | undefined,
    targetSymbol: string | undefined,
    node: SyntaxNode,
    targetMember?: string,
    explicitImport?: string,
  ): void {
    if (!sourceSymbol || !targetSymbol || calls.length >= MAX_CALLS_PER_FILE) return;
    const safeSource = identifier(sourceSymbol);
    const safeTarget = identifier(targetSymbol);
    const safeMember = targetMember ? identifier(targetMember) : undefined;
    if (!safeSource || !safeTarget || safeSource === safeTarget && !safeMember) return;
    const importSpecifier = explicitImport ?? importForTarget(safeTarget, imports, importBindings, grammar.name);
    const line = node.startPosition.row + 1;
    const key = `${safeSource}:${safeTarget}:${safeMember ?? ''}:${importSpecifier ?? ''}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({
      sourceSymbol: safeSource,
      targetSymbol: safeTarget,
      ...(safeMember ? { targetMember: safeMember } : {}),
      ...(importSpecifier ? { importSpecifier } : {}),
      line,
    });
  }

  function visit(node: SyntaxNode, sourceSymbol?: string, insideType = false): void {
    let nextSource = sourceSymbol;
    let nextInsideType = insideType;

    if (grammar.declarationTypes.has(node.type) || grammar.interfaceTypes.has(node.type)) {
      nextSource = getNodeName(node) ?? nextSource;
      nextInsideType = true;
    } else if (grammar.name === 'rust' && node.type === 'impl_item') {
      nextSource = simpleTypeName(node.childForFieldName('type')?.text);
      nextInsideType = true;
    } else if (grammar.name === 'go' && node.type === 'method_declaration') {
      nextSource = goReceiverType(node) ?? nextSource;
      nextInsideType = true;
    } else if (!insideType && grammar.functionTypes.has(node.type)) {
      nextSource = getNodeName(node) ?? nextSource;
    }

    if (callTypes.has(node.type)) {
      const resolved = resolveCall(node, grammar.name, importBindings, variableTypes);
      if (resolved) add(nextSource, resolved.targetSymbol, node, resolved.targetMember, resolved.importSpecifier);
    }

    for (const child of node.namedChildren) visit(child, nextSource, nextInsideType);
  }

  visit(root);
  return calls;
}

interface ResolvedCall {
  targetSymbol: string;
  targetMember?: string;
  importSpecifier?: string;
}

function resolveCall(
  node: SyntaxNode,
  language: string,
  importBindings: Map<string, string>,
  variableTypes: Map<string, string>,
): ResolvedCall | null {
  if (node.type === 'object_creation_expression') {
    const targetSymbol = simpleTypeName(
      node.childForFieldName('type')?.text
      ?? node.namedChildren.find((child) => /type|name/.test(child.type))?.text,
    );
    return targetSymbol ? {
      targetSymbol,
      targetMember: 'constructor',
      ...(importBindings.get(targetSymbol) ? { importSpecifier: importBindings.get(targetSymbol) } : {}),
    } : null;
  }

  if (language === 'java') {
    const targetMember = identifier(node.childForFieldName('name')?.text);
    const qualifier = node.childForFieldName('object')?.text;
    return qualifier && targetMember
      ? resolveQualifiedCall(qualifier, targetMember, language, importBindings, variableTypes)
      : targetMember ? resolveBareCall(targetMember, importBindings) : null;
  }

  if (language === 'php' && (node.type === 'member_call_expression' || node.type === 'scoped_call_expression')) {
    const targetMember = identifier(node.childForFieldName('name')?.text);
    const qualifier = node.childForFieldName('object')?.text ?? node.childForFieldName('scope')?.text;
    return qualifier && targetMember
      ? resolveQualifiedCall(qualifier, targetMember, language, importBindings, variableTypes)
      : null;
  }

  const callable = node.childForFieldName('function')
    ?? node.childForFieldName('name')
    ?? node.namedChildren[0];
  if (!callable) return null;

  if (callable.type === 'identifier' || /(?:name|identifier)$/.test(callable.type) && !/[.:\\]/.test(callable.text)) {
    const target = identifier(callable.text);
    if (!target) return null;
    const resolved = resolveBareCall(target, importBindings);
    return language === 'kotlin' && /^[A-Z]/.test(target)
      ? { ...resolved, targetMember: 'constructor' }
      : resolved;
  }

  if (language === 'rust' && callable.type === 'scoped_identifier') {
    const segments = callable.text.split('::').filter(Boolean);
    const targetSymbol = identifier(segments.at(-1));
    return targetSymbol ? { targetSymbol, importSpecifier: callable.text } : null;
  }

  const targetMember = identifier(
    callable.childForFieldName('field')?.text
    ?? callable.childForFieldName('name')?.text
    ?? callable.namedChildren.at(-1)?.text,
  );
  const qualifier = callable.childForFieldName('operand')?.text
    ?? callable.childForFieldName('object')?.text
    ?? callable.childForFieldName('expression')?.text
    ?? callable.childForFieldName('scope')?.text
    ?? callable.namedChildren[0]?.text;
  return qualifier && targetMember
    ? resolveQualifiedCall(qualifier, targetMember, language, importBindings, variableTypes)
    : null;
}

function resolveBareCall(targetSymbol: string, importBindings: Map<string, string>): ResolvedCall {
  const importSpecifier = importBindings.get(targetSymbol);
  return {
    targetSymbol: importedTargetSymbol(targetSymbol, importSpecifier),
    ...(importSpecifier ? { importSpecifier } : {}),
  };
}

function resolveQualifiedCall(
  rawQualifier: string,
  targetMember: string,
  language: string,
  importBindings: Map<string, string>,
  variableTypes: Map<string, string>,
): ResolvedCall | null {
  const qualifier = qualifierIdentifier(rawQualifier);
  if (!qualifier) return null;
  const importedPackage = importBindings.get(qualifier);
  if (language === 'go' && importedPackage) {
    return { targetSymbol: targetMember, importSpecifier: importedPackage };
  }
  const inferredTarget = variableTypes.get(qualifier) ?? simpleTypeName(rawQualifier);
  if (!inferredTarget) return null;
  const importSpecifier = importBindings.get(inferredTarget);
  const targetSymbol = importedTargetSymbol(inferredTarget, importSpecifier);
  return {
    targetSymbol,
    targetMember,
    ...(importSpecifier ? { importSpecifier } : {}),
  };
}

function importedTargetSymbol(targetSymbol: string, importSpecifier: string | undefined): string {
  if (!importSpecifier || !new RegExp(`\\bas\\s+${targetSymbol}$`, 'i').test(importSpecifier)) return targetSymbol;
  const original = importSpecifier.replace(/\s+as\s+[A-Za-z_]\w+$/i, '');
  return identifier(original.split(/(?:\.|::|\\|\/)/).at(-1)) ?? targetSymbol;
}

function qualifierIdentifier(value: string): string | undefined {
  const candidates = value.match(/[A-Za-z_]\w*/g) ?? [];
  const candidate = candidates.filter((item) => item !== 'this' && item !== 'self').at(-1);
  return identifier(candidate);
}

function createImportBindings(content: string, imports: string[], language: string): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const specifier of imports) {
    const alias = identifier(/\s+as\s+([A-Za-z_]\w+)$/i.exec(specifier)?.[1]);
    const normalized = specifier.replace(/\s+as\s+\w+$/i, '').replace(/\.\*$/, '');
    const name = alias ?? identifier(normalized.split(/(?:\.|::|\\|\/)/).at(-1));
    if (name && name !== '*') bindings.set(name, specifier);
  }
  if (language === 'go') {
    for (const match of content.matchAll(/\b([A-Za-z_]\w*)\s+["`]([^"`]+)["`]/g)) {
      if (match[1] !== 'import') bindings.set(match[1], match[2]);
    }
  }
  if (language === 'php') {
    for (const match of content.matchAll(/\buse\s+[^;]+\\([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)\s*;/gi)) {
      const specifier = imports.find((item) => item.includes(match[1]));
      if (specifier) bindings.set(match[2], specifier);
    }
  }
  return bindings;
}

function importForTarget(
  targetSymbol: string,
  imports: string[],
  bindings: Map<string, string>,
  language: string,
): string | undefined {
  const direct = bindings.get(targetSymbol);
  if (direct) return direct;
  if (language !== 'c-sharp') return undefined;
  const projectNamespaces = imports.filter((item) => !/^(?:System|Microsoft)(?:\.|$)/.test(item));
  return projectNamespaces.length === 1 ? projectNamespaces[0] : undefined;
}

function collectVariableTypes(content: string, language: string): Map<string, string> {
  const variables = new Map<string, string>();
  const add = (name: string | undefined, type: string | undefined) => {
    const safeName = identifier(name?.replace(/^\$/, ''));
    const safeType = simpleTypeName(type);
    if (safeName && safeType) variables.set(safeName, safeType);
  };

  if (language === 'java' || language === 'c-sharp') {
    for (const match of content.matchAll(/\b([A-Z][A-Za-z0-9_.]*(?:\s*<[^;=(){}]+>)?(?:\[\])?)\s+([a-z_]\w*)\b/g)) {
      add(match[2], match[1]);
    }
  } else if (language === 'go') {
    for (const match of content.matchAll(/\bvar\s+([A-Za-z_]\w*)\s+\*?([A-Za-z_]\w*)/g)) add(match[1], match[2]);
    for (const match of content.matchAll(/\b([A-Za-z_]\w*)\s*:=\s*&?([A-Za-z_]\w*)\s*[({]/g)) add(match[1], match[2]);
    for (const match of content.matchAll(/\b([A-Za-z_]\w*)\s+\*?([A-Z][A-Za-z0-9_]*)\b/g)) add(match[1], match[2]);
  } else if (language === 'rust') {
    for (const match of content.matchAll(/\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?::\s*&?(?:mut\s+)?([A-Za-z_]\w*))?\s*=\s*([A-Za-z_]\w*)::/g)) {
      add(match[1], match[2] ?? match[3]);
    }
    for (const match of content.matchAll(/\b([A-Za-z_]\w*)\s*:\s*&?(?:mut\s+)?([A-Z][A-Za-z0-9_]*)/g)) add(match[1], match[2]);
  } else if (language === 'php') {
    for (const match of content.matchAll(/\$([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_\\][A-Za-z0-9_\\]*)/gi)) add(match[1], match[2]);
    for (const match of content.matchAll(/([A-Za-z_\\][A-Za-z0-9_\\]*)\s+\$([A-Za-z_]\w*)/g)) add(match[2], match[1]);
  } else if (language === 'kotlin') {
    for (const match of content.matchAll(/\b(?:val|var)\s+([A-Za-z_]\w*)\s*:\s*([A-Za-z_][A-Za-z0-9_.<>?]*)/g)) add(match[1], match[2]);
    for (const match of content.matchAll(/\b(?:val|var)\s+([A-Za-z_]\w*)\s*=\s*([A-Z][A-Za-z0-9_.]*)\s*\(/g)) add(match[1], match[2]);
  }
  return variables;
}

function goReceiverType(node: SyntaxNode): string | undefined {
  return simpleTypeName(node.childForFieldName('receiver')?.text);
}

function simpleTypeName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const withoutGenerics = value.replace(/<[^<>]*>/g, '');
  return identifier(withoutGenerics.match(/[A-Za-z_]\w*/g)?.at(-1));
}

function identifier(value: string | undefined): string | undefined {
  const match = value?.trim().match(/^[A-Za-z_]\w*$/);
  return match && match[0].length <= 200 ? match[0] : undefined;
}

function extractNamespace(content: string, language: string): string | undefined {
  const pattern = language === 'java'
    ? /^\s*package\s+([\w.]+)\s*;/m
    : language === 'c-sharp'
      ? /^\s*namespace\s+([\w.]+)/m
      : language === 'php'
        ? /^\s*namespace\s+([\w\\]+)\s*;/m
        : language === 'go'
          ? /^\s*package\s+([A-Za-z_]\w*)/m
          : language === 'kotlin'
            ? /^\s*package\s+([\w.]+)/m
            : null;
  return pattern?.exec(content)?.[1];
}

function isInterfaceNode(node: SyntaxNode, grammar: GrammarConfig): boolean {
  return grammar.interfaceTypes.has(node.type)
    || node.childForFieldName('type')?.type === 'interface_type'
    || grammar.name === 'kotlin' && /\binterface\s+[A-Za-z_]\w*/.test(node.text.slice(0, 500));
}

function normalizeGoTypeNode(node: SyntaxNode, grammar: GrammarConfig): SyntaxNode {
  if (grammar.name !== 'go' || node.type !== 'type_spec') return node;
  return node;
}

function collectMembers(node: SyntaxNode, grammar: GrammarConfig): SymbolMember[] {
  const members: SymbolMember[] = [];
  walk(node, (candidate) => {
    if (candidate.id === node.id || !grammar.methodTypes.has(candidate.type)) return;
    const name = getNodeName(candidate);
    if (!name) return;
    members.push(methodMember(candidate, name));
  });
  return deduplicateMembers(members);
}

function attachRustImplMethods(root: SyntaxNode, grammar: GrammarConfig, symbols: ParsedSource['symbols']): void {
  if (grammar.name !== 'rust') return;
  walk(root, (node) => {
    if (node.type !== 'impl_item') return;
    const target = node.childForFieldName('type')?.text.trim();
    if (!target) return;
    const symbol = symbols.find((item) => item.name === target.replace(/^.*::/, ''));
    if (!symbol) return;
    const members: SymbolMember[] = [];
    walk(node.childForFieldName('body') ?? node, (candidate) => {
      if (candidate.type !== 'function_item') return;
      const name = getNodeName(candidate);
      if (name) members.push(methodMember(candidate, name));
    });
    symbol.members = deduplicateMembers([...symbol.members, ...members]);
  });
}

function attachGoMethods(root: SyntaxNode, grammar: GrammarConfig, symbols: ParsedSource['symbols']): void {
  if (grammar.name !== 'go') return;
  walk(root, (node) => {
    if (node.type !== 'method_declaration') return;
    const receiverText = node.childForFieldName('receiver')?.text ?? '';
    const target = [...receiverText.matchAll(/[A-Za-z_]\w*/g)].at(-1)?.[0];
    const name = getNodeName(node);
    if (!target || !name) return;
    const symbol = symbols.find((item) => item.name === target);
    if (symbol) symbol.members = deduplicateMembers([...symbol.members, methodMember(node, name)]);
  });
}

function methodMember(node: SyntaxNode, name: string): SymbolMember {
  const parameters = node.childForFieldName('parameters')?.text
    ?? node.namedChildren.find((child) => /parameter/.test(child.type))?.text
    ?? '()';
  const returnType = node.childForFieldName('return_type')?.text
    ?? node.childForFieldName('type')?.text;
  return {
    name,
    kind: 'method',
    signature: `${name}${truncate(parameters.replace(/\s+/g, ' '), 120)}${returnType ? `: ${truncate(returnType.replace(/\s+/g, ' '), 80)}` : ''}`,
    line: node.startPosition.row + 1,
    ...sourceSnippet(node.text),
  };
}

function sourceSnippet(value: string): Pick<SymbolMember, 'source' | 'sourceTruncated'> {
  const maximumCharacters = 12_000;
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  const truncatedByLines = lines.length > 200;
  let source = lines.slice(0, 200).join('\n');
  const truncatedByCharacters = source.length > maximumCharacters;
  if (truncatedByCharacters) source = source.slice(0, maximumCharacters);
  return {
    source,
    ...((truncatedByLines || truncatedByCharacters) ? { sourceTruncated: true } : {}),
  };
}

function getNodeName(node: SyntaxNode): string | null {
  const fieldName = node.childForFieldName('name')?.text.trim();
  if (fieldName) return fieldName;
  if (node.type === 'type_spec') return node.namedChildren.find((child) => child.type === 'type_identifier')?.text.trim() ?? null;
  if (node.type === 'interface_type') return null;
  return node.namedChildren.find((child) => /(?:type_)?identifier|name/.test(child.type))?.text.trim() ?? null;
}

function extractImport(node: SyntaxNode): string | null {
  const quoted = /["']([^"']+)["']/.exec(node.text)?.[1];
  if (quoted) return quoted;
  return node.text
    .replace(/^(?:import|using|use)\s+(?:static\s+)?/, '')
    .replace(/[;{}]/g, '')
    .trim() || null;
}

function isTypeContainer(type: string, grammar: GrammarConfig): boolean {
  return grammar.declarationTypes.has(type) || grammar.interfaceTypes.has(type) || type === 'impl_item';
}

function walk(node: SyntaxNode, visitor: (node: SyntaxNode) => void): void {
  visitor(node);
  for (const child of node.namedChildren) walk(child, visitor);
}

function addSymbol(symbols: ParsedSource['symbols'], seen: Set<string>, symbol: ParsedSource['symbols'][number]): void {
  const key = `${symbol.kind}:${symbol.name}:${symbol.line}`;
  if (seen.has(key)) return;
  seen.add(key);
  symbols.push(symbol);
}

function deduplicateMembers(members: SymbolMember[]): SymbolMember[] {
  return [...new Map(members.map((member) => [`${member.name}:${member.line ?? 0}`, member])).values()];
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
