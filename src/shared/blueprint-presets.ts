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

const CORE_BLUEPRINT_PRESETS: BlueprintPreset[] = [
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
    tags: ['GoF', 'поведение', 'полиморфизм', 'SOLID'],
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
    tags: ['GoF', 'создание', 'factory', 'полиморфизм'],
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
    tags: ['GoF', 'события', 'подписка', 'loose coupling'],
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
    tags: ['GoF', 'интеграция', 'legacy', 'wrapper'],
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
    tags: ['GoF', 'композиция', 'wrapper', 'Open/Closed'],
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

const ADDITIONAL_ARCHITECTURE_PRESETS: BlueprintPreset[] = [
  preset(
    'layered-architecture', 'Слоистая архитектура', 'architecture',
    'Классическое разделение Presentation, Application, Domain и Infrastructure с направленными зависимостями.',
    ['layers', 'enterprise', 'separation of concerns'],
    [
      node('ui', 'Presentation Layer', 'frontend', 0, 110),
      node('app', 'Application Layer', 'service', 300, 110),
      node('domain', 'Domain Layer', 'module', 600, 110),
      node('infra', 'Infrastructure Layer', 'module', 900, 110),
      node('db', 'Database', 'database', 1200, 110),
    ],
    [edge('ui', 'app', 'calls'), edge('app', 'domain', 'depends'), edge('infra', 'domain', 'depends'), edge('infra', 'db', 'writes')],
  ),
  preset(
    'clean-architecture', 'Clean Architecture', 'architecture',
    'Use cases и entities не зависят от фреймворков; внешние адаптеры подключаются через интерфейсы.',
    ['clean architecture', 'SOLID', 'dependency rule'],
    [
      node('delivery', 'Delivery Adapter', 'controller', 0, 60),
      node('usecase', 'Use Cases', 'service', 310, 60),
      node('entities', 'Entities', 'module', 620, 60),
      node('port', 'Gateway Port', 'interface', 620, 230),
      node('gateway', 'Persistence Gateway', 'class', 930, 230),
      node('db', 'Database', 'database', 1240, 230),
    ],
    [edge('delivery', 'usecase', 'calls'), edge('usecase', 'entities', 'depends'), edge('usecase', 'port', 'depends'), edge('gateway', 'port', 'implements'), edge('gateway', 'db', 'writes')],
  ),
  preset(
    'backend-for-frontend', 'Backend for Frontend', 'architecture',
    'Отдельные BFF оптимизируют API и агрегацию данных под Web и Mobile клиенты.',
    ['BFF', 'API', 'mobile', 'web'],
    [
      node('web', 'Web App', 'frontend', 0, 20), node('mobile', 'Mobile App', 'frontend', 0, 210),
      node('web-bff', 'Web BFF', 'gateway', 310, 20), node('mobile-bff', 'Mobile BFF', 'gateway', 310, 210),
      node('catalog', 'Catalog Service', 'service', 650, 0), node('orders', 'Order Service', 'service', 650, 150),
      node('profile', 'Profile Service', 'service', 650, 300),
    ],
    [edge('web', 'web-bff', 'http'), edge('mobile', 'mobile-bff', 'http'), edge('web-bff', 'catalog', 'http'), edge('web-bff', 'orders', 'http'), edge('mobile-bff', 'orders', 'http'), edge('mobile-bff', 'profile', 'http')],
  ),
  preset(
    'serverless-event-app', 'Serverless Event App', 'architecture',
    'API и события запускают независимые функции с managed queue, object storage и NoSQL.',
    ['serverless', 'FaaS', 'events', 'cloud'],
    [
      node('client', 'Client', 'frontend', 0, 80), node('api', 'API Gateway', 'gateway', 270, 80),
      node('command', 'Command Function', 'service', 550, 20, 'Lambda / Functions'),
      node('worker', 'Event Function', 'service', 550, 190, 'Lambda / Functions'),
      node('queue', 'Managed Queue', 'queue', 850, 190), node('db', 'NoSQL Store', 'database', 850, 20),
      node('storage', 'Object Storage', 'external', 1140, 190),
    ],
    [edge('client', 'api', 'http'), edge('api', 'command', 'http'), edge('command', 'db', 'writes'), edge('command', 'queue', 'event'), edge('worker', 'queue', 'event', 'trigger'), edge('worker', 'storage', 'writes')],
  ),
  preset(
    'saga-orchestration', 'Saga · Orchestration', 'architecture',
    'Оркестратор координирует распределённую транзакцию и запускает компенсирующие команды при ошибке.',
    ['saga', 'distributed transaction', 'compensation'],
    [
      node('api', 'Order API', 'controller', 0, 110), node('saga', 'Saga Orchestrator', 'service', 290, 110),
      node('order', 'Order Service', 'service', 610, 0), node('payment', 'Payment Service', 'service', 610, 110),
      node('stock', 'Inventory Service', 'service', 610, 220), node('bus', 'Command Bus', 'queue', 920, 110),
      node('audit', 'Saga Log', 'database', 920, 260),
    ],
    [edge('api', 'saga', 'http'), edge('saga', 'bus', 'event', 'commands'), edge('order', 'bus', 'event'), edge('payment', 'bus', 'event'), edge('stock', 'bus', 'event'), edge('saga', 'audit', 'writes')],
  ),
  preset(
    'plugin-architecture', 'Plugin Architecture', 'architecture',
    'Стабильное ядро загружает изолированные расширения через контракт и registry.',
    ['plugins', 'microkernel', 'extensibility'],
    [
      node('shell', 'Application Shell', 'system', 0, 100), node('core', 'Core Runtime', 'service', 300, 100),
      node('contract', 'Plugin Contract', 'interface', 610, 100), node('registry', 'Plugin Registry', 'component', 610, 260),
      node('auth', 'Auth Plugin', 'class', 930, 0), node('billing', 'Billing Plugin', 'class', 930, 150),
      node('reporting', 'Reporting Plugin', 'class', 930, 300),
    ],
    [edge('shell', 'core', 'calls'), edge('core', 'contract', 'depends'), edge('core', 'registry', 'calls'), edge('auth', 'contract', 'implements'), edge('billing', 'contract', 'implements'), edge('reporting', 'contract', 'implements')],
  ),
  preset(
    'streaming-data-pipeline', 'Streaming Data Pipeline', 'architecture',
    'Поток событий проходит ingestion, broker, обработку, аналитическое хранилище и observability.',
    ['streaming', 'ETL', 'Kafka', 'analytics'],
    [
      node('sources', 'Event Sources', 'external', 0, 100), node('ingest', 'Ingestion API', 'service', 280, 100),
      node('broker', 'Event Broker', 'queue', 570, 100, 'Kafka / Pulsar'), node('processor', 'Stream Processor', 'service', 860, 30),
      node('dead-letter', 'Dead Letter Queue', 'queue', 860, 210), node('warehouse', 'Data Warehouse', 'database', 1160, 30),
      node('dashboard', 'Analytics', 'frontend', 1450, 30),
    ],
    [edge('sources', 'ingest', 'event'), edge('ingest', 'broker', 'event'), edge('processor', 'broker', 'event', 'subscribe'), edge('processor', 'warehouse', 'writes'), edge('processor', 'dead-letter', 'event'), edge('dashboard', 'warehouse', 'reads')],
  ),
  preset(
    'multi-tenant-saas', 'Multi-tenant SaaS', 'architecture',
    'Tenant-aware gateway, identity, application services и варианты изоляции данных для SaaS.',
    ['SaaS', 'multi-tenant', 'identity', 'isolation'],
    [
      node('client', 'Tenant Client', 'frontend', 0, 100), node('gateway', 'Tenant Gateway', 'gateway', 290, 100),
      node('identity', 'Identity Service', 'service', 590, 0), node('app', 'Application Service', 'service', 590, 170),
      node('resolver', 'Tenant Resolver', 'component', 900, 80), node('shared-db', 'Shared Tenant DB', 'database', 1210, 0),
      node('isolated-db', 'Isolated Tenant DB', 'database', 1210, 180),
    ],
    [edge('client', 'gateway', 'http'), edge('gateway', 'identity', 'http'), edge('gateway', 'app', 'http'), edge('app', 'resolver', 'calls'), edge('resolver', 'shared-db', 'writes'), edge('resolver', 'isolated-db', 'writes')],
  ),
];

const ADDITIONAL_GOF_PRESETS: BlueprintPreset[] = [
  preset('abstract-factory', 'Abstract Factory', 'creational', 'Создаёт согласованные семейства связанных объектов без привязки к конкретным классам.', ['GoF', 'factory', 'families'], [
    node('client', 'Application', 'class', 0, 100), node('factory', 'UIFactory', 'interface', 300, 100),
    node('win-factory', 'WindowsFactory', 'class', 610, 0), node('mac-factory', 'MacFactory', 'class', 610, 190),
    node('button', 'Button', 'interface', 930, 20), node('checkbox', 'Checkbox', 'interface', 930, 180),
  ], [edge('client', 'factory', 'depends'), edge('win-factory', 'factory', 'implements'), edge('mac-factory', 'factory', 'implements'), edge('win-factory', 'button', 'creates'), edge('mac-factory', 'checkbox', 'creates')]),
  preset('builder', 'Builder', 'creational', 'Пошагово собирает сложный объект, отделяя процесс построения от представления.', ['GoF', 'construction', 'fluent API'], [
    node('director', 'Director', 'class', 0, 100), node('builder', 'Builder', 'interface', 310, 100),
    node('concrete', 'ConcreteBuilder', 'class', 630, 100), node('product', 'Product', 'class', 950, 100),
  ], [edge('director', 'builder', 'calls'), edge('concrete', 'builder', 'implements'), edge('concrete', 'product', 'creates')]),
  preset('prototype', 'Prototype', 'creational', 'Создаёт новые объекты клонированием настроенного прототипа.', ['GoF', 'clone', 'creation'], [
    node('client', 'Client', 'class', 0, 100), node('prototype', 'Prototype', 'interface', 310, 100),
    node('alpha', 'ConcretePrototypeA', 'class', 640, 0), node('beta', 'ConcretePrototypeB', 'class', 640, 190),
  ], [edge('client', 'prototype', 'calls', 'clone'), edge('alpha', 'prototype', 'implements'), edge('beta', 'prototype', 'implements')]),
  preset('singleton', 'Singleton', 'creational', 'Гарантирует единственный экземпляр и предоставляет контролируемую точку доступа.', ['GoF', 'single instance', 'lifecycle'], [
    node('client-a', 'Client A', 'class', 0, 20), node('client-b', 'Client B', 'class', 0, 190),
    node('singleton', 'Singleton', 'class', 360, 105),
  ], [edge('client-a', 'singleton', 'calls', 'instance'), edge('client-b', 'singleton', 'calls', 'instance')]),
  preset('bridge', 'Bridge', 'structural', 'Разделяет абстракцию и реализацию, чтобы они изменялись независимо.', ['GoF', 'composition', 'abstraction'], [
    node('abstraction', 'Abstraction', 'abstract-class', 0, 100), node('refined', 'RefinedAbstraction', 'class', 0, 260),
    node('implementor', 'Implementor', 'interface', 360, 100), node('impl-a', 'ConcreteImplA', 'class', 700, 0), node('impl-b', 'ConcreteImplB', 'class', 700, 190),
  ], [edge('refined', 'abstraction', 'extends'), edge('abstraction', 'implementor', 'depends'), edge('impl-a', 'implementor', 'implements'), edge('impl-b', 'implementor', 'implements')]),
  preset('composite', 'Composite', 'structural', 'Объединяет объекты в дерево и позволяет одинаково работать с листьями и контейнерами.', ['GoF', 'tree', 'part-whole'], [
    node('client', 'Client', 'class', 0, 100), node('component', 'Component', 'interface', 300, 100),
    node('leaf', 'Leaf', 'class', 640, 0), node('composite', 'Composite', 'class', 640, 190),
  ], [edge('client', 'component', 'depends'), edge('leaf', 'component', 'implements'), edge('composite', 'component', 'implements'), edge('composite', 'component', 'depends', 'children')]),
  preset('facade', 'Facade', 'structural', 'Предоставляет простой вход к сложному набору подсистем.', ['GoF', 'API', 'subsystem'], [
    node('client', 'Client', 'class', 0, 100), node('facade', 'SubsystemFacade', 'class', 300, 100),
    node('catalog', 'CatalogSubsystem', 'class', 640, 0), node('payment', 'PaymentSubsystem', 'class', 640, 120), node('shipping', 'ShippingSubsystem', 'class', 640, 240),
  ], [edge('client', 'facade', 'calls'), edge('facade', 'catalog', 'calls'), edge('facade', 'payment', 'calls'), edge('facade', 'shipping', 'calls')]),
  preset('flyweight', 'Flyweight', 'structural', 'Разделяет общее внутреннее состояние между множеством мелких объектов.', ['GoF', 'memory', 'shared state'], [
    node('client', 'Forest', 'class', 0, 100), node('factory', 'TreeTypeFactory', 'class', 300, 100),
    node('flyweight', 'TreeType', 'class', 630, 30), node('context', 'Tree Context', 'class', 630, 200),
  ], [edge('client', 'factory', 'calls'), edge('factory', 'flyweight', 'creates'), edge('context', 'flyweight', 'depends')]),
  preset('proxy', 'Proxy', 'structural', 'Контролирует доступ к объекту: lazy loading, cache, security или remote access.', ['GoF', 'access control', 'lazy'], [
    node('client', 'Client', 'class', 0, 100), node('subject', 'Subject', 'interface', 300, 100),
    node('proxy', 'SubjectProxy', 'class', 630, 0), node('real', 'RealSubject', 'class', 630, 200),
  ], [edge('client', 'subject', 'depends'), edge('proxy', 'subject', 'implements'), edge('real', 'subject', 'implements'), edge('proxy', 'real', 'calls')]),
  preset('chain-of-responsibility', 'Chain of Responsibility', 'behavioral', 'Передаёт запрос по цепочке обработчиков до первого подходящего звена.', ['GoF', 'pipeline', 'handlers'], [
    node('client', 'Client', 'class', 0, 100), node('handler', 'Handler', 'abstract-class', 300, 100),
    node('auth', 'AuthHandler', 'class', 630, 0), node('validation', 'ValidationHandler', 'class', 630, 120), node('business', 'BusinessHandler', 'class', 630, 240),
  ], [edge('client', 'handler', 'calls'), edge('auth', 'handler', 'extends'), edge('validation', 'handler', 'extends'), edge('business', 'handler', 'extends'), edge('auth', 'validation', 'calls', 'next'), edge('validation', 'business', 'calls', 'next')]),
  preset('command', 'Command', 'behavioral', 'Инкапсулирует действие как объект для очередей, истории, undo и повторного выполнения.', ['GoF', 'undo', 'queue'], [
    node('invoker', 'Invoker', 'class', 0, 100), node('command', 'Command', 'interface', 310, 100),
    node('save', 'SaveCommand', 'class', 640, 0), node('publish', 'PublishCommand', 'class', 640, 190), node('receiver', 'Receiver', 'class', 960, 100),
  ], [edge('invoker', 'command', 'calls'), edge('save', 'command', 'implements'), edge('publish', 'command', 'implements'), edge('save', 'receiver', 'calls'), edge('publish', 'receiver', 'calls')]),
  preset('interpreter', 'Interpreter', 'behavioral', 'Описывает грамматику и вычисляет выражения предметного языка.', ['GoF', 'DSL', 'grammar'], [
    node('client', 'Client', 'class', 0, 100), node('expression', 'Expression', 'interface', 300, 100),
    node('terminal', 'TerminalExpression', 'class', 630, 0), node('nonterminal', 'CompositeExpression', 'class', 630, 190), node('context', 'Context', 'class', 950, 100),
  ], [edge('client', 'expression', 'calls', 'interpret'), edge('terminal', 'expression', 'implements'), edge('nonterminal', 'expression', 'implements'), edge('expression', 'context', 'depends')]),
  preset('iterator', 'Iterator', 'behavioral', 'Обходит коллекцию без раскрытия её внутреннего представления.', ['GoF', 'collection', 'traversal'], [
    node('client', 'Client', 'class', 0, 100), node('aggregate', 'Aggregate', 'interface', 300, 20), node('iterator', 'Iterator', 'interface', 300, 190),
    node('collection', 'ConcreteCollection', 'class', 640, 20), node('concrete', 'ConcreteIterator', 'class', 640, 190),
  ], [edge('client', 'aggregate', 'depends'), edge('client', 'iterator', 'calls'), edge('collection', 'aggregate', 'implements'), edge('concrete', 'iterator', 'implements'), edge('collection', 'concrete', 'creates')]),
  preset('mediator', 'Mediator', 'behavioral', 'Централизует взаимодействия компонентов и уменьшает прямые зависимости между ними.', ['GoF', 'coordination', 'loose coupling'], [
    node('mediator', 'Mediator', 'interface', 320, 100), node('dialog', 'DialogMediator', 'class', 650, 100),
    node('button', 'Button', 'component', 0, 0), node('field', 'TextField', 'component', 0, 120), node('list', 'List', 'component', 0, 240),
  ], [edge('dialog', 'mediator', 'implements'), edge('button', 'mediator', 'event'), edge('field', 'mediator', 'event'), edge('list', 'mediator', 'event')]),
  preset('memento', 'Memento', 'behavioral', 'Сохраняет и восстанавливает состояние объекта без нарушения инкапсуляции.', ['GoF', 'history', 'snapshot'], [
    node('caretaker', 'History', 'class', 0, 100), node('originator', 'Editor', 'class', 330, 100), node('memento', 'EditorMemento', 'class', 660, 100),
  ], [edge('caretaker', 'memento', 'depends', 'stores'), edge('originator', 'memento', 'creates'), edge('caretaker', 'originator', 'calls', 'restore')]),
  preset('state', 'State', 'behavioral', 'Меняет поведение контекста при смене внутреннего состояния.', ['GoF', 'state machine', 'behavior'], [
    node('context', 'OrderContext', 'class', 0, 100), node('state', 'OrderState', 'interface', 320, 100),
    node('new', 'NewState', 'class', 650, 0), node('paid', 'PaidState', 'class', 650, 120), node('shipped', 'ShippedState', 'class', 650, 240),
  ], [edge('context', 'state', 'depends'), edge('new', 'state', 'implements'), edge('paid', 'state', 'implements'), edge('shipped', 'state', 'implements')]),
  preset('template-method', 'Template Method', 'behavioral', 'Базовый класс задаёт скелет алгоритма, а подклассы переопределяют отдельные шаги.', ['GoF', 'inheritance', 'algorithm'], [
    node('template', 'DataMiner', 'abstract-class', 300, 100), node('pdf', 'PdfDataMiner', 'class', 0, 230), node('csv', 'CsvDataMiner', 'class', 300, 230), node('json', 'JsonDataMiner', 'class', 600, 230),
  ], [edge('pdf', 'template', 'extends'), edge('csv', 'template', 'extends'), edge('json', 'template', 'extends')]),
  preset('visitor', 'Visitor', 'behavioral', 'Добавляет операции к структуре объектов без изменения классов её элементов.', ['GoF', 'operations', 'double dispatch'], [
    node('client', 'Client', 'class', 0, 100), node('element', 'Element', 'interface', 300, 20), node('visitor', 'Visitor', 'interface', 300, 190),
    node('order', 'OrderElement', 'class', 640, 0), node('invoice', 'InvoiceElement', 'class', 640, 100), node('exporter', 'ExportVisitor', 'class', 640, 230),
  ], [edge('client', 'element', 'depends'), edge('order', 'element', 'implements'), edge('invoice', 'element', 'implements'), edge('exporter', 'visitor', 'implements'), edge('element', 'visitor', 'calls', 'accept')]),
];

export const BLUEPRINT_PRESETS: BlueprintPreset[] = [
  ...CORE_BLUEPRINT_PRESETS,
  ...ADDITIONAL_ARCHITECTURE_PRESETS,
  ...ADDITIONAL_GOF_PRESETS,
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

function preset(
  id: string,
  title: string,
  category: BlueprintPresetCategory,
  description: string,
  tags: string[],
  nodes: BlueprintPresetNode[],
  edges: BlueprintPresetEdge[],
): BlueprintPreset {
  return { id, title, category, description, tags, nodes, edges };
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
