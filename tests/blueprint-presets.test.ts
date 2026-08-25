import { describe, expect, it } from 'vitest';
import { BLUEPRINT_PRESETS, createBlueprintFromPreset } from '../src/shared/blueprint-presets.js';
import { validateArchitectureBlueprint } from '../src/shared/blueprint.js';

describe('Blueprint presets', () => {
  it('instantiates every preset as a valid isolated blueprint', () => {
    for (const preset of BLUEPRINT_PRESETS) {
      let sequence = 0;
      const blueprint = createBlueprintFromPreset(preset, '/tmp/project', () => uuid(sequence++));
      expect(validateArchitectureBlueprint(blueprint), preset.id).toBeNull();
      expect(new Set(blueprint.nodes.map((node) => node.id)).size).toBe(blueprint.nodes.length);
      expect(blueprint.edges.length).toBe(preset.edges.length);
    }
  });

  it('contains architecture and all three GoF pattern categories', () => {
    expect(new Set(BLUEPRINT_PRESETS.map((preset) => preset.category))).toEqual(
      new Set(['architecture', 'creational', 'structural', 'behavioral']),
    );
  });

  it('contains the complete catalog of 23 GoF patterns', () => {
    const gofIds = [
      'abstract-factory', 'builder', 'factory-method', 'prototype', 'singleton',
      'adapter', 'bridge', 'composite', 'decorator', 'facade', 'flyweight', 'proxy',
      'chain-of-responsibility', 'command', 'interpreter', 'iterator', 'mediator', 'memento',
      'observer', 'state', 'strategy', 'template-method', 'visitor',
    ];
    const availableIds = new Set(BLUEPRINT_PRESETS.map((preset) => preset.id));
    const taggedGoFIds = new Set(BLUEPRINT_PRESETS.filter((preset) => preset.tags.includes('GoF')).map((preset) => preset.id));
    expect(gofIds).toHaveLength(23);
    expect(gofIds.every((id) => availableIds.has(id))).toBe(true);
    expect(taggedGoFIds).toEqual(new Set(gofIds));
  });

  it('provides an expanded architecture catalog', () => {
    expect(new Set(BLUEPRINT_PRESETS.map((preset) => preset.id)).size).toBe(BLUEPRINT_PRESETS.length);
    expect(BLUEPRINT_PRESETS.filter((preset) => preset.category === 'architecture').length).toBeGreaterThanOrEqual(12);
    expect(BLUEPRINT_PRESETS.length).toBeGreaterThanOrEqual(36);
  });
});

function uuid(value: number): string {
  return `123e4567-e89b-42d3-a456-${value.toString(16).padStart(12, '0')}`;
}
