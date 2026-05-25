import { Injectable } from '@nestjs/common';

/**
 * Minimal `{{key}}` template renderer.
 *
 *   renderer.render('Hello {{name}}', { name: 'Alex' })  // 'Hello Alex'
 *
 * Missing keys are left as-is (or you can set `strict: true` to throw).
 */
@Injectable()
export class TemplateRenderer {
  render(
    template: string,
    vars: Record<string, unknown>,
    options: { strict?: boolean } = {},
  ): string {
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
      const value = this.lookup(vars, key);
      if (value === undefined) {
        if (options.strict) {
          throw new Error(`Missing template variable: ${key}`);
        }
        return match;
      }
      return typeof value === 'string' ? value : JSON.stringify(value);
    });
  }

  private lookup(vars: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, part) => {
      if (acc && typeof acc === 'object' && part in acc) {
        return (acc as Record<string, unknown>)[part];
      }
      return undefined;
    }, vars);
  }
}
