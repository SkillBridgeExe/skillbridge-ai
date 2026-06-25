/**
 * Validate a JSON schema against OpenAI structured-output STRICT rules — the same rules
 * OpenAI rejects at request time with a `400 Invalid schema ...`. When that 400 happens in
 * prod the affected flow silently degrades to its fallback (it already killed cv_intake and
 * interview_end for days before anyone noticed). This validator turns that latent runtime 400
 * into a loud, located failure we can catch in CI BEFORE deploy.
 *
 * Strict rules enforced (per https://platform.openai.com/docs/guides/structured-outputs):
 *  - every object node MUST set `additionalProperties: false`
 *  - every object node MUST define `properties`
 *  - every object node MUST have a `required` array listing EXACTLY all keys of `properties`
 *    (optional fields are expressed as nullable unions, e.g. `type: ['string', 'null']`,
 *     NOT by omission from `required`)
 *  - recurse through `properties`, array `items`, and composition keywords (anyOf/oneOf/allOf)
 *
 * Nullable objects (`type: ['object', 'null']`) are still validated as objects — they must
 * carry full `properties`/`required`/`additionalProperties`.
 */
export function assertStrictSchema(schema: unknown, path = '$'): void {
  if (!schema || typeof schema !== 'object') return;
  const node = schema as Record<string, unknown>;

  // Composition keywords: recurse into each branch.
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = node[key];
    if (Array.isArray(branches)) {
      branches.forEach((b, i) => assertStrictSchema(b, `${path}.${key}[${i}]`));
    }
  }

  const rawType = node.type;
  const types = Array.isArray(rawType) ? rawType : rawType ? [rawType] : [];
  const hasProps =
    !!node.properties && typeof node.properties === 'object' && !Array.isArray(node.properties);
  const isObjectNode = types.includes('object') || (hasProps && types.length === 0);

  if (isObjectNode) {
    if (node.additionalProperties !== false) {
      throw new Error(
        `Strict-schema violation at ${path}: object must set "additionalProperties: false".`,
      );
    }
    if (!hasProps) {
      throw new Error(`Strict-schema violation at ${path}: object must define "properties".`);
    }
    const propKeys = Object.keys(node.properties as Record<string, unknown>).sort();
    if (!Array.isArray(node.required)) {
      throw new Error(`Strict-schema violation at ${path}: object must define a "required" array.`);
    }
    const required = [...(node.required as string[])].sort();
    if (JSON.stringify(propKeys) !== JSON.stringify(required)) {
      throw new Error(
        `Strict-schema violation at ${path}: "required" must list ALL property keys. ` +
          `properties=[${propKeys.join(', ')}] required=[${required.join(', ')}]`,
      );
    }
    for (const k of propKeys) {
      assertStrictSchema((node.properties as Record<string, unknown>)[k], `${path}.${k}`);
    }
  }

  if (types.includes('array') && node.items) {
    assertStrictSchema(node.items, `${path}[]`);
  }
}
