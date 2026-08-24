# Code Atlas

Локальный генератор интерактивной карты программного проекта. Он сканирует исходники без исполнения кода, определяет сервисы, языки, технологии и базы данных, строит связи импортов и позволяет проваливаться от сервиса к модулю, классу и методам.

## Что уже работает

- интерактивная 2D-карта с панорамированием, масштабом, minimap и перетаскиванием узлов;
- импорт проекта по абсолютному локальному пути;
- поиск и фильтры слоев;
- сервисы по manifest-файлам (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, Maven/Gradle и другие);
- языковая статистика для TypeScript/JavaScript, Python, Java/Kotlin, Go, Rust, C#, PHP, Ruby, Swift, Dart и web-файлов;
- глубокий разбор классов, интерфейсов, функций, методов, контроллеров и HTTP-маршрутов для TypeScript/JavaScript и Python;
- базовый разбор символов для Java/Kotlin/Go/Rust/C#/PHP;
- обнаружение PostgreSQL, MySQL/MariaDB, MongoDB, Redis, SQLite, Elasticsearch и DynamoDB;
- безопасные ограничения: локальный bind, CORS/HTTP-заголовки, rate limit, игнорирование зависимостей/сборок, симлинков и больших файлов, лимит на размер снимка.

## Запуск

Требуется Node.js 22+.

```bash
npm install
npm run dev
```

Откройте [http://localhost:5173](http://localhost:5173). При первом запуске появится демонстрационная карта. В верхней строке укажите абсолютный путь к любому локальному проекту и нажмите «Построить карту».

## Проверка

```bash
npm run typecheck
npm test
npm run build
```

## Архитектура

```text
Browser / React Flow
        │  GET /api/demo · POST /api/analyze
        ▼
Fastify local API
        │
        ▼
Static analyzer ──► normalized graph schema ──► 2D renderer
      │                    │
      ├─ manifests         └─ готово для будущего 3D renderer
      ├─ source parsers
      └─ infra detectors
```

Сервер слушает только `127.0.0.1`, не запускает код анализируемого проекта и не переходит по симлинкам.

## Следующий этап

1. Tree-sitter адаптеры и точное разрешение импортов для всех заявленных языков.
2. 3D-режим на React Three Fiber с общей моделью графа.
3. Git history/ownership, hotspots и дифф между ветками.
4. Фоновое индексирование больших монорепозиториев и хранение снимков в SQLite.
5. Desktop-оболочка Tauri для системного выбора папки.
