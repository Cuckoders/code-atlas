import { createRequire } from 'node:module';
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
};

const require = createRequire(import.meta.url);
const coreWasmPath = require.resolve('web-tree-sitter/web-tree-sitter.wasm');
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
): GrammarConfig {
  return {
    name,
    wasm: `@vscode/tree-sitter-wasm/wasm/tree-sitter-${name}.wasm`,
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
    language = Language.load(require.resolve(grammar.wasm));
    languageCache.set(grammar.name, language);
  }
  return language;
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
          kind: grammar.interfaceTypes.has(typeNode.type) || typeNode.childForFieldName('type')?.type === 'interface_type'
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

  return {
    symbols,
    imports: [...new Set(imports)],
    calls: [],
    namespace: extractNamespace(root.text, grammar.name),
    routes: [],
    parser: `Tree-sitter WASM · ${grammar.name}`,
  };
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
          : null;
  return pattern?.exec(content)?.[1];
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
