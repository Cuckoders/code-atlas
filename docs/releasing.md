# Выпуск desktop-версии

Проект разделяет проверочные сборки и публичный релиз. `.github/workflows/desktop-build.yml` создаёт неподписанные CI-артефакты на нативных раннерах macOS arm64, macOS x64, Linux x64 и Windows x64. `.github/workflows/release.yml` запускается только вручную, требует существующий тег текущей версии и создаёт черновик GitHub Release.

## Что настроено

- Node.js `24.16.0` и Rust `1.96.0` закреплены в CI/release для воспроизводимого sidecar runtime; локально поддерживается актуальный stable Rust с `clippy` и `rustfmt`;
- macOS собирается на нативных Apple Silicon и Intel runners, поэтому внутрь пакета не попадает Node runtime другой архитектуры;
- macOS release-сборка останавливается до компиляции, если отсутствуют данные Developer ID и notarization;
- Windows x64 нативно собирает оба формата (`.msi` и NSIS `.exe`), запускает реальный Node sidecar smoke-test и после упаковки проверяет PE/MSI-сигнатуры, SHA-256 sidecar и наличие обоих установщиков;
- WiX upgrade code закреплён в конфигурации, downgrade заблокирован, а NSIS использует current-user installation и English/Russian installer resources;
- action-компоненты закреплены полными commit SHA, permissions ограничены на чтение, а `contents: write` выдаётся только финальному job, создающему draft release;
- ключи доступны только двум macOS build-steps и не передаются pull request workflow;
- версия в `package.json`, `src-tauri/tauri.conf.json` и release tag проверяется до сборки;
- опубликованные пакеты получают файл `SHA256SUMS.txt`.

Windows-пакеты в текущем workflow не имеют Authenticode-подписи. Linux AppImage/DEB также не подписываются отдельным GPG-ключом. До добавления соответствующих сертификатов draft release не следует переводить в public release для внешних пользователей.

## Локальная проверка Windows

Windows-пакет намеренно собирается только на Windows: `build:sidecar` сравнивает host и target triple, поэтому в установщик нельзя случайно вложить macOS/Linux Node runtime. Требуются Windows 10/11 x64, Node.js версии из `.nvmrc`, Rust MSVC toolchain, Visual Studio Build Tools с workload `Desktop development with C++` и WebView2 для запуска dev-окна.

```powershell
npm ci
npm run release:verify -- --versions-only
npm run typecheck
npm test
npm run test:windows-contract
npm run build:sidecar
npm run test:sidecar
npm run desktop:build -- --bundles msi,nsis
npm run verify:windows-bundle
```

Последняя команда проверяет:

- имя `code-atlas-node-x86_64-pc-windows-msvc.exe` и соответствие sidecar его SHA-256 manifest;
- PE-заголовки sidecar, `code-atlas.exe` и NSIS installer;
- Compound File Binary заголовок MSI;
- наличие обоих установщиков в нативной Tauri output-директории.

Проверка не заменяет Authenticode. До подключения сертификата Windows может показывать SmartScreen warning для скачанного пакета.

## GitHub Environment и секреты Apple

Создайте GitHub Environment с именем `release`, включите required reviewers и добавьте в него:

- `APPLE_CERTIFICATE` — Developer ID Application certificate в формате `.p12`, закодированный base64;
- `APPLE_CERTIFICATE_PASSWORD` — пароль экспорта `.p12`;
- `APPLE_ID` — Apple ID для notarization;
- `APPLE_PASSWORD` — app-specific password, не основной пароль Apple ID;
- `APPLE_TEAM_ID` — Team ID Apple Developer.

Секреты нельзя помещать в `.env`, workflow YAML, issues, build logs или git history. Release job выводит только имена отсутствующих переменных и никогда не печатает их значения.

## Порядок выпуска

1. Обновить версию одновременно в `package.json` и `src-tauri/tauri.conf.json`, затем обновить lockfile командой `npm install --package-lock-only`.
2. Выполнить `npm run release:verify -- --versions-only`, полный CI и native desktop matrix.
3. Настроить GitHub protected tag rule для `v*`, создать и отправить подписанный git tag вида `v0.1.0`. Его commit должен быть достижим из `main`.
4. В GitHub Actions вручную запустить `Draft release`, указать этот тег и подтвердить `confirm_publish`.
5. Скачать draft assets, проверить `SHA256SUMS.txt`, macOS code signature/notarization и Windows signing status.
6. Публиковать draft только после завершения платформенных проверок.

## Автообновление

Updater пока намеренно не активирован. Tauri не разрешает неподписанные обновления, а корректная конфигурация требует двух данных, которых в локальном репозитории ещё нет: постоянного HTTPS endpoint будущего release-репозитория и настоящего публичного updater-ключа.

После создания remote-репозитория:

1. Сгенерировать отдельную ключевую пару Tauri signer на защищённой машине.
2. Сохранить приватный ключ и его пароль только как `TAURI_SIGNING_PRIVATE_KEY` и `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` в GitHub Environment `release`.
3. Закрепить публичный ключ в `src-tauri/tauri.conf.json` и добавить HTTPS endpoint `latest.json` конкретного GitHub Release repository.
4. Подключить `tauri-plugin-updater` в Rust и frontend, выдать только updater permissions и включить `bundle.createUpdaterArtifacts`.
5. Добавить `.sig` и `latest.json` в draft release, затем проверить upgrade с предыдущей подписанной версией на всех четырёх targets.

Приватный updater-ключ нельзя восстанавливать из публичного ключа или заменять между версиями: его потеря разрывает цепочку обновлений для уже установленных приложений.
