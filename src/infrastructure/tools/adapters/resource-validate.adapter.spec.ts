import { ResourceValidateAdapter } from './resource-validate.adapter';
import { ToolBadArgsError } from '../types';

describe('ResourceValidateAdapter', () => {
  it('rejects a non-http(s) or missing url', () => {
    const adapter = new ResourceValidateAdapter();
    expect(() => adapter.argsSchema({})).toThrow(ToolBadArgsError);
    expect(() => adapter.argsSchema({ url: 'javascript:alert(1)' })).toThrow(ToolBadArgsError);
  });

  it('accepts a valid https url', () => {
    const adapter = new ResourceValidateAdapter();
    expect(adapter.argsSchema({ url: 'https://x.dev/course' })).toEqual({ url: 'https://x.dev/course' });
  });
});
