// Settings schemas are shipped fully dereferenced: no `$ref` at all. The bundler inlines a shared definition
// at its first use and points later references at that property, so a later reference would pick up the
// `default` and `x-minRole` of the first one. Dereferencing gives every reference its own copy, and the
// siblings of a `$ref` (`default`, `x-minRole`, `description`) apply only there.
import $RefParser from '@apidevtools/json-schema-ref-parser';

export async function derefSettings(file) {
  const schema = await $RefParser.dereference(file, { dereference: { circular: false } });
  // dereference shares one object between all references to a definition; the round trip copies each
  return JSON.parse(JSON.stringify(schema));
}
