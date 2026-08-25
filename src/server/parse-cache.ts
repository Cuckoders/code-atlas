import type { NodeKind, SymbolMember } from '../shared/graph.js';
import type { ParsedSource } from './tree-sitter-parser.js';

export const PARSER_CACHE_VERSION = 1;
export const MAX_PARSE_CACHE_JSON_SIZE = 2 * 1024 * 1024;

export interface ParseCache {
  getParsedSource(projectPath: string, relativePath: string, contentHash: string): ParsedSource | null | Promise<ParsedSource | null>;
  setParsedSource(projectPath: string, relativePath: string, contentHash: string, parsed: ParsedSource): void | Promise<void>;
}

const SYMBOL_KINDS = new Set<NodeKind>(['controller', 'class', 'interface', 'function']);
const MEMBER_KINDS = new Set<SymbolMember['kind']>(['method', 'property', 'route']);

export function parseCachedSource(value: string): ParsedSource | null {
  if (Buffer.byteLength(value, 'utf8') > MAX_PARSE_CACHE_JSON_SIZE) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return validateParsedSource(parsed);
  } catch {
    return null;
  }
}

export function validateParsedSource(value: unknown): ParsedSource | null {
  return isParsedSource(value) ? value : null;
}

function isParsedSource(value: unknown): value is ParsedSource {
  if (!isRecord(value)) return false;
  return (
    isStringArray(value.imports)
    && typeof value.parser === 'string'
    && value.parser.length <= 200
    && (value.namespace === undefined || typeof value.namespace === 'string')
    && Array.isArray(value.routes)
    && value.routes.every(isSymbolMember)
    && Array.isArray(value.symbols)
    && value.symbols.every((symbol) => (
      isRecord(symbol)
      && typeof symbol.name === 'string'
      && symbol.name.length <= 500
      && typeof symbol.kind === 'string'
      && SYMBOL_KINDS.has(symbol.kind as NodeKind)
      && Number.isInteger(symbol.line)
      && Array.isArray(symbol.members)
      && symbol.members.every(isSymbolMember)
    ))
    && Array.isArray(value.calls)
    && value.calls.every((call) => (
      isRecord(call)
      && typeof call.sourceSymbol === 'string'
      && typeof call.targetSymbol === 'string'
      && (call.importSpecifier === undefined || typeof call.importSpecifier === 'string')
      && Number.isInteger(call.line)
    ))
  );
}

function isSymbolMember(value: unknown): value is SymbolMember {
  return isRecord(value)
    && typeof value.name === 'string'
    && value.name.length <= 1_000
    && typeof value.kind === 'string'
    && MEMBER_KINDS.has(value.kind as SymbolMember['kind'])
    && (value.signature === undefined || typeof value.signature === 'string')
    && (value.line === undefined || Number.isInteger(value.line))
    && (value.source === undefined || typeof value.source === 'string')
    && (value.sourceTruncated === undefined || typeof value.sourceTruncated === 'boolean');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
