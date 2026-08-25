import { describe, expect, it } from 'vitest';
import { parseWithTreeSitter } from '../src/server/tree-sitter-parser.js';

const cases = [
  {
    language: 'Java',
    extension: '.java',
    source: `
      import java.util.List;
      public class InventoryController {
        public List<String> listStock() { return List.of(); }
        public void reserve(String id) {}
      }
    `,
    symbol: 'InventoryController',
    method: 'reserve',
  },
  {
    language: 'Go',
    extension: '.go',
    source: `
      package orders
      import "context"
      type OrderService struct { name string }
      func (s *OrderService) Create(ctx context.Context) error { return nil }
    `,
    symbol: 'OrderService',
    method: 'Create',
  },
  {
    language: 'Rust',
    extension: '.rs',
    source: `
      use std::sync::Arc;
      struct PricingEngine { rate: f64 }
      impl PricingEngine {
        fn calculate(&self, amount: f64) -> f64 { amount * self.rate }
      }
    `,
    symbol: 'PricingEngine',
    method: 'calculate',
  },
  {
    language: 'C#',
    extension: '.cs',
    source: `
      using System;
      public class PaymentController {
        public bool Capture(string id) { return true; }
      }
    `,
    symbol: 'PaymentController',
    method: 'Capture',
  },
  {
    language: 'PHP',
    extension: '.php',
    source: `<?php
      use App\\Domain\\Order;
      class OrderController {
        public function submit(string $id): bool { return true; }
      }
    `,
    symbol: 'OrderController',
    method: 'submit',
  },
  {
    language: 'Kotlin',
    extension: '.kt',
    source: `
      package commerce.checkout
      import commerce.inventory.InventoryService
      interface CheckoutPort { fun submit(id: String): Boolean; }
      class CheckoutController(private val inventory: InventoryService) : CheckoutPort {
        override fun submit(id: String): Boolean { return inventory.reserve(id) };
      }
    `,
    symbol: 'CheckoutController',
    method: 'submit',
  },
] as const;

describe('Tree-sitter WASM adapters', () => {
  for (const testCase of cases) {
    it(`extracts ${testCase.language} types and methods`, async () => {
      const result = await parseWithTreeSitter(testCase.extension, testCase.source);
      const symbol = result?.symbols.find((item) => item.name === testCase.symbol);

      expect(result?.parser).toContain('Tree-sitter WASM');
      expect(symbol).toBeDefined();
      expect(symbol?.members.some((member) => member.name === testCase.method)).toBe(true);
    });
  }

  const callCases = [
    {
      language: 'Java',
      extension: '.java',
      source: `
        package demo;
        class InventoryService { void reserve() {} }
        class InventoryController {
          InventoryService service;
          void submit() { this.service.reserve(); }
        }
      `,
      expected: { sourceSymbol: 'InventoryController', targetSymbol: 'InventoryService', targetMember: 'reserve' },
    },
    {
      language: 'Go',
      extension: '.go',
      source: `
        package orders
        func persist() {}
        func Run() { persist() }
      `,
      expected: { sourceSymbol: 'Run', targetSymbol: 'persist' },
    },
    {
      language: 'Rust',
      extension: '.rs',
      source: `
        fn quote() -> i32 { 1 }
        fn run() { quote(); }
      `,
      expected: { sourceSymbol: 'run', targetSymbol: 'quote' },
    },
    {
      language: 'C#',
      extension: '.cs',
      source: `
        class PaymentService { public void Charge() {} }
        class PaymentController {
          PaymentService service;
          public void Capture() { this.service.Charge(); }
        }
      `,
      expected: { sourceSymbol: 'PaymentController', targetSymbol: 'PaymentService', targetMember: 'Charge' },
    },
    {
      language: 'PHP',
      extension: '.php',
      source: `<?php
        class OrderService { public function save(): void {} }
        class OrderController {
          public function submit(): void {
            $service = new OrderService();
            $service->save();
          }
        }
      `,
      expected: { sourceSymbol: 'OrderController', targetSymbol: 'OrderService', targetMember: 'save' },
    },
    {
      language: 'Kotlin',
      extension: '.kt',
      source: `
        package demo
        import demo.inventory.InventoryService as StockService
        class CheckoutController(private val inventory: StockService) {
          fun submit(id: String): Boolean { return inventory.reserve(id) };
        }
      `,
      expected: {
        sourceSymbol: 'CheckoutController',
        targetSymbol: 'InventoryService',
        targetMember: 'reserve',
        importSpecifier: 'demo.inventory.InventoryService as StockService',
      },
    },
  ] as const;

  for (const testCase of callCases) {
    it(`extracts conservative ${testCase.language} call targets`, async () => {
      const result = await parseWithTreeSitter(testCase.extension, testCase.source);
      expect(result?.calls).toEqual(expect.arrayContaining([
        expect.objectContaining(testCase.expected),
      ]));
    });
  }

  it('parses Kotlin script files with the same verified grammar', async () => {
    const result = await parseWithTreeSitter('.kts', 'fun configure() { println("ready") }');
    expect(result?.symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'configure', kind: 'function' }),
    ]));
    expect(result?.parser).toBe('Tree-sitter WASM · kotlin');
  });
});
