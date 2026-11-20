import { describe, expect, it } from 'vitest';
import { generateArrangementVersion } from '../src/lib/arrangementVersions';
import { createDemoProject } from '../src/lib/demo';
import type { ArrangementOptions } from '../src/lib/types';

describe('frozen whole-song plans', () => {
  it.each(['lyrical', 'groove'] as const)(
    'uses the saved plan in the %s engine and can replay it',
    (engine) => {
      const source = createDemoProject();
      const options: ArrangementOptions = {
        engine,
        preset: 'solo-satb',
        style: 'pop',
        transpose: 0,
        percussion: false,
        difficulty: 'medium',
        leadPartId: source.parts[0].id,
      };
      const rule = generateArrangementVersion(source, options).project;
      options.formPlan = {
        inputSHA256: 'a'.repeat(64),
        model: 'test-planner',
        sections: [
          {
            id: 'section-1',
            label: '副歌',
            startBar: 1,
            bars: source.measures,
            kind: 'chorus',
            texture: 'answer',
            energy: 4,
            bass: 'pulse',
            rationale: '上声部接句。',
          },
        ],
      };
      const model = generateArrangementVersion(source, options).project;
      expect(model.arrangement?.plan?.planner).toBe('model');
      expect(rule.arrangement?.plan?.planner).toBe('rule');
      expect(model.arrangement?.plan?.sections).toEqual(options.formPlan.sections);
      const savedOptions = JSON.parse(JSON.stringify(model.arrangement!.options));
      expect(generateArrangementVersion(source, savedOptions, model).identical).toBe(true);
      savedOptions.formPlan.sections[0].bars--;
      expect(() => generateArrangementVersion(source, savedOptions)).toThrow();
    },
  );
});
