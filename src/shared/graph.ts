export type NodeKind =
  | 'project'
  | 'service'
  | 'database'
  | 'module'
  | 'controller'
  | 'class'
  | 'interface'
  | 'function';

export type EdgeKind = 'contains' | 'imports' | 'uses';

export interface SymbolMember {
  name: string;
  kind: 'method' | 'property' | 'route';
  signature?: string;
  line?: number;
}

export interface AtlasNode {
  id: string;
  label: string;
  kind: NodeKind;
  path?: string;
  language?: string;
  subtitle?: string;
  members?: SymbolMember[];
  metadata?: Record<string, string | number | boolean | string[]>;
}

export interface AtlasEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
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
  durationMs: number;
  truncated: boolean;
}

export interface ProjectAnalysis {
  summary: ProjectSummary;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  warnings: string[];
}
