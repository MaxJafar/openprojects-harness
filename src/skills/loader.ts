import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Ajv } from 'ajv';

import type { JsonObject, SkillDefinition } from '../core/types.js';

const manifestSchema: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'name', 'description', 'tools', 'evaluators'],
  properties: {
    id: { type: 'string', pattern: '^[a-z0-9-]+$' },
    version: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    description: { type: 'string', minLength: 1 },
    tools: { type: 'array', items: { type: 'string' } },
    evaluators: { type: 'array', items: { type: 'string' } },
  },
};

export function loadSkills(directory = resolve('skills')): SkillDefinition[] {
  if (!existsSync(directory)) return [];
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(manifestSchema);
  const skills: SkillDefinition[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(directory, entry.name, 'skill.json');
    const instructionsPath = join(directory, entry.name, 'SKILL.md');
    if (!existsSync(manifestPath) || !existsSync(instructionsPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
    if (!validate(manifest)) {
      throw new Error(`Invalid skill ${entry.name}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`);
    }
    const typed = manifest as Omit<SkillDefinition, 'instructions'>;
    if (typed.id !== entry.name) {
      throw new Error(`Skill directory ${entry.name} does not match manifest id ${typed.id}`);
    }
    skills.push({ ...typed, instructions: readFileSync(instructionsPath, 'utf8').trim() });
  }
  return skills.sort((left, right) => left.id.localeCompare(right.id));
}
