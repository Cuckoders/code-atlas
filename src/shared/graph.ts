export type NodeKind =
  | 'project'
  | 'service'
  | 'database'
  | 'module'
  | 'controller'
  | 'class'
  | 'interface'
  | 'function';

export type EdgeKind = 'contains' | 'imports' | 'calls' | 'uses';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export type DiagnosticKind =
  | 'dependency-cycle'
  | 'high-coupling'
  | 'cross-service-dependency'
  | 'isolated-module'
  | 'shared-database'
  | 'change-hotspot';

export interface GitComparison {
  baseRef: string;
  changedFiles: number;
  added: number;
  modified: number;
  deleted: number;
  architecture?: ArchitectureDiffSummary;
}

export interface ArchitectureDiffSummary {
  nodesAdded: number;
  nodesModified: number;
  nodesRemoved: number;
  edgesAdded: number;
  edgesRemoved: number;
}

export interface GitSummary {
  available: boolean;
  branch?: string;
  commitsAnalyzed: number;
  contributors: string[];
  lastCommitAt?: string;
  comparison?: GitComparison;
}

export interface SymbolMember {
  name: string;
  kind: 'method' | 'property' | 'route';
  signature?: string;
  line?: number;
  source?: string;
  sourceTruncated?: boolean;
}

export interface SourceDiffLine {
  kind: 'context' | 'added' | 'removed';
  content: string;
  beforeLine?: number;
  afterLine?: number;
}

export interface ChangedSymbolMember {
  name: string;
  kind: SymbolMember['kind'];
  before: SymbolMember;
  after: SymbolMember;
  sourceDiff?: SourceDiffLine[];
}

export interface NodeStructureDiff {
  added: SymbolMember[];
  removed: SymbolMember[];
  changed: ChangedSymbolMember[];
}

export interface AtlasNode {
  id: string;
  label: string;
  kind: NodeKind;
  path?: string;
  language?: string;
  subtitle?: string;
  members?: SymbolMember[];
  structureDiff?: NodeStructureDiff;
  metadata?: Record<string, string | number | boolean | string[]>;
}

export interface AtlasEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
  change?: 'added' | 'removed';
}

export interface ProjectDiagnostic {
  id: string;
  kind: DiagnosticKind;
  severity: DiagnosticSeverity;
  title: string;
  message: string;
  nodeIds: string[];
  edgeIds?: string[];
}

export interface LanguageStat {
  name: string;
  files: number;
  percentage: number;
}

export interface ProjectSummary {
  name: string;
  rootPath: string;
  filesScanned: number;
  filesSkipped: number;
  services: number;
  modules: number;
  symbols: number;
  databases: string[];
  technologies: string[];
  languages: LanguageStat[];
  git: GitSummary;
  durationMs: number;
  truncated: boolean;
}

export interface ProjectAnalysis {
  summary: ProjectSummary;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  diagnostics: ProjectDiagnostic[];
  warnings: string[];
}
