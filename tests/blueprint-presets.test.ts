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
});

function uuid(value: number): string {
  return `123e4567-e89b-42d3-a456-${value.toString(16).padStart(12, '0')}`;
}
