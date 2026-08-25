import {
  BLUEPRINT_VERSION,
  type ArchitectureBlueprintDraft,
  type BlueprintEdgeKind,
  type BlueprintNodeKind,
  type BlueprintNodeStatus,
} from './blueprint.js';

export type BlueprintPresetCategory =
  | 'architecture'
  | 'creational'
  | 'structural'
  | 'behavioral';

export interface BlueprintPresetNode {
  key: string;
  label: string;
  kind: BlueprintNodeKind;
  position: { x: number; y: number };
  status?: BlueprintNodeStatus;
  technology?: string;
  language?: string;
}

export interface BlueprintPresetEdge {
  source: string;
  target: string;
  kind: BlueprintEdgeKind;
  label?: string;
}

export interface BlueprintPreset {
  id: string;
  title: string;
  category: BlueprintPresetCategory;
  description: string;
  tags: string[];
  nodes: BlueprintPresetNode[];
  edges: BlueprintPresetEdge[];
}

export const BLUEPRINT_PRESETS: BlueprintPreset[] = [
  {
    id: 'modular-monolith',
    title: 'Модульный монолит',
    category: 'architecture',
    description: 'Единое приложение с явными границами domain-модулей и общей инфраструктурой.',
    tags: ['DDD', 'монолит', 'модули'],
    nodes: [
      node('system', 'Commerce Platform', 'system', 0, 150),
      node('api', 'Web API', 'service', 280, 150, 'Fastify / Spring'),
      node('orders', 'Orders Module', 'module', 570, 20),
      node('catalog', 'Catalog Module', 'module', 570, 150),
      node('billing', 'Billing Module', 'module', 570, 280),
      node('db', 'PostgreSQL', 'database', 880, 150),
    ],
    edges: [
      edge('system', 'api', 'http'), edge('api', 'orders', 'depends'), edge('api', 'catalog', 'depends'),
      edge('api', 'billing', 'depends'), edge('orders', 'db', 'writes'), edge('catalog', 'db', 'reads'), edge('billing', 'db', 'writes'),
    ],
  },
  {
    id: 'microservices',
    title: 'Микросервисы',
    category: 'architecture',
    description: 'API Gateway, независимые сервисы, отдельные хранилища и асинхронные события.',
    tags: ['gateway', 'events', 'database per service'],
    nodes: [
      node('client', 'Web / Mobile', 'frontend', 0, 140),
      node('gateway', 'API Gateway', 'gateway', 270, 140),
      node('catalog', 'Catalog Service', 'service', 550, 0),
      node('orders', 'Order Service', 'service', 550, 140),
      node('notifications', 'Notification Service', 'service', 550, 280),
      node('catalog-db', 'Catalog DB', 'database', 860, 0),
      node('orders-db', 'Orders DB', 'database', 860, 140),
      node('events', 'Event Bus', 'queue', 860, 280, 'Kafka / NATS'),
      node('payments', 'Payment Provider', 'external', 860, 410),
    ],
    edges: [
      edge('client', 'gateway', 'http'), edge('gateway', 'catalog', 'http'), edge('gateway', 'orders', 'http'),
      edge('catalog', 'catalog-db', 'writes'), edge('orders', 'orders-db', 'writes'), edge('orders', 'events', 'event', 'OrderCreated'),
      edge('notifications', 'events', 'event', 'subscribe'), edge('orders', 'payments', 'http'),
    ],
  },
  {
    id: 'event-driven',
    title: 'Event-driven / CQRS',
    category: 'architecture',
    description: 'Команды изменяют write model, события обновляют read model и подписчиков.',
    tags: ['CQRS', 'event sourcing', 'async'],
    nodes: [
      node('api', 'Command API', 'service', 0, 80),
      node('handler', 'Command Handler', 'controller', 280, 80),
      node('write-db', 'Write Model', 'database', 560, 0),
      node('bus', 'Event Bus', 'queue', 560, 160, 'Kafka / RabbitMQ'),
      node('projector', 'Read Projector', 'service', 840, 80),
      node('read-db', 'Read Model', 'database', 1120, 80),
      node('consumer', 'Integration Consumer', 'service', 840, 240),
    ],
    edges: [
      edge('api', 'handler', 'http'), edge('handler', 'write-db', 'writes'), edge('handler', 'bus', 'event', 'DomainEvent'),
      edge('projector', 'bus', 'event', 'subscribe'), edge('projector', 'read-db', 'writes'), edge('consumer', 'bus', 'event', 'subscribe'),
    ],
  },
  {
    id: 'hexagonal',
    title: 'Hexagonal Architecture',
    category: 'architecture',
    description: 'Домен изолирован портами, а инфраструктура подключается через адаптеры.',
    tags: ['ports & adapters', 'clean architecture', 'DDD'],
    nodes: [
      node('http', 'HTTP Controller', 'controller', 0, 40),
      node('usecase', 'Application Use Case', 'class', 300, 40),
      node('domain', 'Domain Model', 'module', 600, 40),
      node('port', 'Repository Port', 'interface', 600, 200),
      node('adapter', 'SQL Adapter', 'class', 900, 200),
      node('db', 'PostgreSQL', 'database', 1200, 200),
    ],
    edges: [
      edge('http', 'usecase', 'calls'), edge('usecase', 'domain', 'depends'), edge('usecase', 'port', 'depends'),
      edge('adapter', 'port', 'implements'), edge('adapter', 'db', 'writes'),
    ],
  },
  {
    id: 'strategy',
    title: 'Strategy',
    category: 'behavioral',
    description: 'Семейство взаимозаменяемых алгоритмов за общим интерфейсом.',
    tags: ['поведение', 'полиморфизм', 'SOLID'],
    nodes: [
      node('context', 'PaymentContext', 'class', 0, 100),
      node('strategy', 'PaymentStrategy', 'interface', 330, 100),
      node('card', 'CardPayment', 'class', 660, 0),
      node('crypto', 'CryptoPayment', 'class', 660, 180),
    ],
    edges: [edge('context', 'strategy', 'depends'), edge('card', 'strategy', 'implements'), edge('crypto', 'strategy', 'implements')],
  },
  {
    id: 'factory-method',
    title: 'Factory Method',
    category: 'creational',
    description: 'Создание продукта делегируется подклассам creator-а.',
    tags: ['создание', 'factory', 'полиморфизм'],
    nodes: [
      node('creator', 'DialogCreator', 'abstract-class', 0, 50),
      node('concrete-creator', 'WebDialog', 'class', 0, 220),
      node('product', 'Button', 'interface', 360, 50),
      node('concrete-product', 'HtmlButton', 'class', 680, 50),
    ],
    edges: [
      edge('concrete-creator', 'creator', 'extends'), edge('creator', 'product', 'creates'),
      edge('concrete-creator', 'concrete-product', 'creates'), edge('concrete-product', 'product', 'implements'),
    ],
  },
  {
    id: 'observer',
    title: 'Observer',
    category: 'behavioral',
    description: 'Publisher уведомляет независимых подписчиков об изменениях.',
    tags: ['события', 'подписка', 'loose coupling'],
    nodes: [
      node('subject', 'EventPublisher', 'class', 0, 100),
      node('observer', 'EventObserver', 'interface', 350, 100),
      node('email', 'EmailObserver', 'class', 700, 0),
      node('audit', 'AuditObserver', 'class', 700, 180),
    ],
    edges: [edge('subject', 'observer', 'event', 'notify'), edge('email', 'observer', 'implements'), edge('audit', 'observer', 'implements')],
  },
  {
    id: 'adapter',
    title: 'Adapter',
    category: 'structural',
    description: 'Преобразует несовместимый интерфейс внешнего компонента в ожидаемый контракт.',
    tags: ['интеграция', 'legacy', 'wrapper'],
    nodes: [
      node('client', 'CheckoutService', 'class', 0, 100),
      node('target', 'PaymentPort', 'interface', 330, 100),
      node('adapter', 'StripeAdapter', 'class', 660, 100),
      node('adaptee', 'Stripe SDK', 'external', 990, 100),
    ],
    edges: [edge('client', 'target', 'depends'), edge('adapter', 'target', 'implements'), edge('adapter', 'adaptee', 'calls')],
  },
  {
    id: 'decorator',
    title: 'Decorator',
    category: 'structural',
    description: 'Добавляет поведение объекту через композицию без изменения исходного класса.',
    tags: ['композиция', 'wrapper', 'Open/Closed'],
    nodes: [
      node('component', 'DataSource', 'interface', 0, 80),
      node('concrete', 'FileDataSource', 'class', 330, 0),
      node('base', 'DataSourceDecorator', 'abstract-class', 330, 180),
      node('encrypt', 'EncryptionDecorator', 'class', 680, 100),
    ],
    edges: [
      edge('concrete', 'component', 'implements'), edge('base', 'component', 'implements'),
      edge('base', 'component', 'depends'), edge('encrypt', 'base', 'extends'),
    ],
  },
  {
    id: 'repository',
    title: 'Repository',
    category: 'structural',
    description: 'Изолирует доменную модель от деталей доступа к данным.',
    tags: ['DDD', 'persistence', 'database'],
    nodes: [
      node('service', 'OrderService', 'class', 0, 80),
      node('entity', 'Order', 'class', 330, 0),
      node('repository', 'OrderRepository', 'interface', 330, 180),
      node('sql', 'SqlOrderRepository', 'class', 660, 180),
      node('db', 'PostgreSQL', 'database', 990, 180),
    ],
    edges: [
      edge('service', 'entity', 'depends'), edge('service', 'repository', 'depends'),
      edge('sql', 'repository', 'implements'), edge('sql', 'db', 'writes'),
    ],
  },
];

export function createBlueprintFromPreset(
  preset: BlueprintPreset,
  projectPath: string,
  createId: () => string,
): ArchitectureBlueprintDraft {
  const ids = new Map(preset.nodes.map((item) => [item.key, createId()]));
  return {
    version: BLUEPRINT_VERSION,
    projectPath,
    nodes: preset.nodes.map((item) => ({
      id: ids.get(item.key)!,
      label: item.label,
      kind: item.kind,
      position: item.position,
      status: item.status ?? 'planned',
      ...(item.technology ? { technology: item.technology } : {}),
      ...(item.language ? { language: item.language } : {}),
    })),
    edges: preset.edges.map((item) => ({
      id: createId(),
      source: requiredPresetNodeId(ids, item.source),
      target: requiredPresetNodeId(ids, item.target),
      kind: item.kind,
      ...(item.label ? { label: item.label } : {}),
    })),
  };
}

function node(
  key: string,
  label: string,
  kind: BlueprintNodeKind,
  x: number,
  y: number,
  technology?: string,
): BlueprintPresetNode {
  return { key, label, kind, position: { x, y }, ...(technology ? { technology } : {}) };
}

function edge(source: string, target: string, kind: BlueprintEdgeKind, label?: string): BlueprintPresetEdge {
  return { source, target, kind, ...(label ? { label } : {}) };
}

function requiredPresetNodeId(ids: Map<string, string>, key: string): string {
  const id = ids.get(key);
  if (!id) throw new Error(`Preset references unknown node: ${key}`);
  return id;
}
