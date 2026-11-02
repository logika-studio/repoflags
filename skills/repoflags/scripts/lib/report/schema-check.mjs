// Minimal JSON Schema subset validator (D-29). Works on reports we produce; never throws on arbitrary input.
// Supported: type, required, properties, additionalProperties, enum, pattern, minLength, maxLength, minimum, items, minItems.

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(want, v) {
  const t = typeOf(v);
  return want === t || (want === 'number' && t === 'integer');
}

const has = (o, k) => Object.hasOwn(o, k);

export function validate(schema, value, path = '$') {
  const errors = [];
  if (schema === null || typeof schema !== 'object') return errors;

  if (has(schema, 'type')) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wanted.some((w) => typeMatches(w, value))) {
      errors.push(`${path}: expected ${wanted.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (has(schema, 'enum') && !schema.enum.includes(value)) {
    errors.push(`${path}: value not in enum`);
  }
  if (typeof value === 'string') {
    if (has(schema, 'minLength') && value.length < schema.minLength) errors.push(`${path}: shorter than minLength`);
    if (has(schema, 'maxLength') && value.length > schema.maxLength) errors.push(`${path}: longer than maxLength`);
    if (has(schema, 'pattern') && !new RegExp(schema.pattern).test(value)) errors.push(`${path}: does not match pattern`);
  }
  if (typeof value === 'number' && has(schema, 'minimum') && value < schema.minimum) {
    errors.push(`${path}: below minimum`);
  }
  if (Array.isArray(value)) {
    if (has(schema, 'minItems') && value.length < schema.minItems) errors.push(`${path}: fewer than minItems`);
    if (has(schema, 'items')) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const props = has(schema, 'properties') ? schema.properties : {};
    for (const key of has(schema, 'required') ? schema.required : []) {
      if (!has(value, key)) errors.push(`${path}.${key}: required`);
    }
    for (const key of Object.keys(value)) {
      if (has(props, key)) {
        errors.push(...validate(props[key], value[key], `${path}.${key}`));
      } else if (has(schema, 'additionalProperties')) {
        const ap = schema.additionalProperties;
        if (ap === false) errors.push(`${path}.${key}: undeclared key`);
        else if (ap && typeof ap === 'object') errors.push(...validate(ap, value[key], `${path}.${key}`));
      }
    }
  }
  return errors;
}
