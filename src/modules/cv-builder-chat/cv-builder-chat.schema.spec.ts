import { CV_BUILDER_CHAT_SCHEMA as S } from './cv-builder-chat.schema';

describe('CV_BUILDER_CHAT_SCHEMA', () => {
  it('every property is required (OpenAI strict) and optionals are nullable', () => {
    const props = Object.keys((S as any).properties);
    expect((S as any).required.sort()).toEqual(props.sort());
    expect((S as any).properties.proposed_edit.type).toContain('null');
    expect((S as any).properties.cited_field_path.type).toContain('null');
    expect((S as any).properties.suggested_next_step.type).toContain('null');
  });

  it('proposed_edit inner object also requires all its keys and forbids extras', () => {
    const pe = (S as any).properties.proposed_edit;
    expect(pe.required.sort()).toEqual(['after', 'field_path']);
    expect(pe.additionalProperties).toBe(false);
  });

  it('top level forbids additional properties', () => {
    expect((S as any).additionalProperties).toBe(false);
    expect((S as any).type).toBe('object');
  });
});
