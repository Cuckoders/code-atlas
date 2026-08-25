import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AnalysisError, analyzeProject } from '../src/server/analyzer.js';
import type { AnalysisProgress } from '../src/shared/graph.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(currentDirectory, '../examples/sample-commerce');

describe('analyzeProject', () => {
  it('discovers services, languages, databases and source symbols', async () => {
    const result = await analyzeProject(fixturePath);

    expect(result.summary.services).toBe(3);
    expect(result.summary.modules).toBe(7);
    expect(result.summary.databases).toEqual(expect.arrayContaining(['PostgreSQL', 'Redis']));
    expect(result.summary.languages.map((language) => language.name)).toEqual(
      expect.arrayContaining(['TypeScript', 'Python', 'Java', 'Kotlin']),
    );
    expect(result.nodes.some((node) => node.label === 'CatalogController' && node.kind === 'controller')).toBe(true);
    expect(result.nodes.some((node) => (
      node.label === 'InventoryController'
      && node.kind === 'controller'
      && node.members?.some((member) => member.name === 'reserve')
    ))).toBe(true);
    expect(result.nodes.some((node) => node.label === 'OrderJob' && node.members?.some((member) => member.name === 'execute'))).toBe(true);
    expect(result.nodes.some((node) => (
      node.label === 'NotificationPort'
      && node.kind === 'interface'
      && node.members?.some((member) => member.name === 'send')
    ))).toBe(true);
    expect(result.edges.some((edge) => edge.kind === 'imports')).toBe(true);
    const nodeById = new Map(result.nodes.map((node) => [node.id, node]));
    expect(result.edges.some((edge) => (
      edge.kind === 'calls'
      && nodeById.get(edge.source)?.label === 'registerCatalogRoutes'
      && nodeById.get(edge.target)?.label === 'ProductRepository'
    ))).toBe(true);
    expect(result.edges.some((edge) => (
      edge.kind === 'calls'
      && nodeById.get(edge.source)?.label === 'InventoryController'
      && nodeById.get(edge.target)?.label === 'InventoryService'
      && edge.label?.includes('.reserve')
    ))).toBe(true);
    expect(result.edges.some((edge) => (
      edge.kind === 'calls'
      && nodeById.get(edge.source)?.label === 'NotificationController'
      && nodeById.get(edge.target)?.label === 'NotificationSender'
      && edge.label?.includes('.deliver')
    ))).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.kind === 'isolated-module')).toBe(true);
  });

  it('resolves Java namespaces and reports import cycles', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-atlas-cycle-'));
    try {
      await fs.writeFile(path.join(temporaryRoot, 'pom.xml'), '<project />');
      await fs.mkdir(path.join(temporaryRoot, 'src', 'alpha'), { recursive: true });
      await fs.mkdir(path.join(temporaryRoot, 'src', 'beta'), { recursive: true });
      await fs.writeFile(path.join(temporaryRoot, 'src', 'alpha', 'Alpha.java'), `
        package demo.alpha;
        import demo.beta.Beta;
        public class Alpha {}
      `);
      await fs.writeFile(path.join(temporaryRoot, 'src', 'beta', 'Beta.java'), `
        package demo.beta;
        import demo.alpha.Alpha;
        public class Beta {}
      `);

      const result = await analyzeProject(temporaryRoot);
      const importEdges = result.edges.filter((edge) => edge.kind === 'imports');
      expect(importEdges).toHaveLength(2);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'dependency-cycle', severity: 'error' }),
      ]));
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects a missing directory', async () => {
    await expect(analyzeProject(path.join(fixturePath, 'missing'))).rejects.toBeInstanceOf(AnalysisError);
  });

  it('reports bounded file-level progress through every analysis phase', async () => {
    const progress: AnalysisProgress[] = [];

    await analyzeProject(fixturePath, { onProgress: (update) => progress.push(update) });

    expect(progress[0]).toEqual({ phase: 'scanning', processedFiles: 0, totalFiles: 0, percentage: 0 });
    expect(progress).toContainEqual({ phase: 'parsing', processedFiles: 7, totalFiles: 7, percentage: 100 });
    expect(progress.at(-1)).toEqual({ phase: 'finalizing', processedFiles: 1, totalFiles: 1, percentage: 100 });
    expect(progress.every((update) => update.percentage >= 0 && update.percentage <= 100)).toBe(true);
  });

  it('resolves Tree-sitter calls across Java imports and Go package files', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-atlas-polyglot-calls-'));
    try {
      const javaRoot = path.join(temporaryRoot, 'java-service');
      const goRoot = path.join(temporaryRoot, 'go-service');
      await fs.mkdir(path.join(javaRoot, 'src', 'demo'), { recursive: true });
      await fs.mkdir(goRoot, { recursive: true });
      await fs.writeFile(path.join(javaRoot, 'pom.xml'), '<project />');
      await fs.writeFile(path.join(javaRoot, 'src', 'demo', 'InventoryService.java'), `
        package demo;
        public class InventoryService { public void reserve() {} }
      `);
      await fs.writeFile(path.join(javaRoot, 'src', 'demo', 'InventoryController.java'), `
        package demo;
        import demo.InventoryService;
        public class InventoryController {
          private InventoryService service;
          public void submit() { this.service.reserve(); }
        }
      `);
      await fs.writeFile(path.join(goRoot, 'go.mod'), 'module example.com/orders\n');
      await fs.writeFile(path.join(goRoot, 'persist.go'), 'package orders\nfunc Persist() {}\n');
      await fs.writeFile(path.join(goRoot, 'run.go'), 'package orders\nfunc Run() { Persist() }\n');

      const result = await analyzeProject(temporaryRoot);
      const nodeById = new Map(result.nodes.map((node) => [node.id, node]));
      const calls = result.edges.filter((edge) => edge.kind === 'calls').map((edge) => ({
        source: nodeById.get(edge.source)?.label,
        target: nodeById.get(edge.target)?.label,
        label: edge.label,
      }));

      expect(calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'InventoryController', target: 'InventoryService', label: expect.stringContaining('.reserve') }),
        expect.objectContaining({ source: 'Run', target: 'Persist' }),
      ]));
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('resolves Kotlin aliases, namespaces, constructors, and method calls', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'code-atlas-kotlin-calls-'));
    try {
      await fs.mkdir(path.join(temporaryRoot, 'src', 'main', 'kotlin', 'demo', 'inventory'), { recursive: true });
      await fs.mkdir(path.join(temporaryRoot, 'src', 'main', 'kotlin', 'demo', 'checkout'), { recursive: true });
      await fs.writeFile(path.join(temporaryRoot, 'build.gradle.kts'), 'plugins { kotlin("jvm") version "2.2.0" }\n');
      await fs.writeFile(path.join(temporaryRoot, 'src', 'main', 'kotlin', 'demo', 'inventory', 'InventoryService.kt'), `
        package demo.inventory
        class InventoryService { fun reserve(id: String): Boolean { return true }; }
      `);
      await fs.writeFile(path.join(temporaryRoot, 'src', 'main', 'kotlin', 'demo', 'checkout', 'CheckoutController.kt'), `
        package demo.checkout
        import demo.inventory.InventoryService as StockService
        class CheckoutController(private val inventory: StockService) {
          fun submit(id: String): Boolean { return inventory.reserve(id) };
        }
        fun boot() { CheckoutController(StockService()) }
      `);

      const result = await analyzeProject(temporaryRoot);
      const nodeById = new Map(result.nodes.map((node) => [node.id, node]));
      const calls = result.edges.filter((edge) => edge.kind === 'calls').map((edge) => ({
        source: nodeById.get(edge.source)?.label,
        target: nodeById.get(edge.target)?.label,
        label: edge.label,
      }));

      expect(calls).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'CheckoutController', target: 'InventoryService', label: expect.stringContaining('.reserve') }),
        expect.objectContaining({ source: 'boot', target: 'CheckoutController', label: expect.stringContaining('.constructor') }),
        expect.objectContaining({ source: 'boot', target: 'InventoryService', label: expect.stringContaining('.constructor') }),
      ]));
      expect(result.summary.languages).toContainEqual(expect.objectContaining({ name: 'Kotlin', files: 3 }));
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
