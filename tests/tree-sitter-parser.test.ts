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
});
