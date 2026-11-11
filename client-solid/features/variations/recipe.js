// Dialog-private raw recipe ownership. Presentation and IO evidence never enter
// this representation. Native Files are opaque resources.
import { snapshotDraft, sameDraft, RECIPE_FIELDS, freezeRecipe, validRecipeValue, recipeField } from "/shared/features/variations/recipe-model.mjs";
export { RECIPE_FIELDS, freezeRecipe, validRecipeValue, recipeField, recipeDispositions, moveRecipeImage } from "/shared/features/variations/recipe-model.mjs";

export function makeVariationRecipe() {
  const groups = new Map(Object.keys(RECIPE_FIELDS).map(domain => [domain, new Map()]));
  let revision = 0;
  const row = (domain, id) => groups.get(domain)?.get(id);
  const capture = () => Object.fromEntries([...groups].map(([domain, entries]) => [domain,
    Object.fromEntries([...entries].map(([id, entry]) => [id, snapshotDraft(entry)]))]));
  return {
    row, entries: domain => groups.get(domain), revision: () => revision, edited: () => revision++, capture,
    seed(domain, id, metadata, defaults) {
      let entry = row(domain, id);
      if (!entry) { entry = { metadata: {}, values: {}, baseline: {}, touched: [] }; groups.get(domain).set(id, entry); }
      entry.metadata = freezeRecipe(snapshotDraft({ ...entry.metadata, ...metadata }));
      for (const [name, value] of Object.entries(defaults)) {
        if (!validRecipeValue(recipeField(domain, name).type, value)) throw new Error(`Invalid default: ${domain}.${name}`);
        if (!entry.touched.includes(name)) { entry.values[name] = snapshotDraft(value); entry.baseline[name] = snapshotDraft(value); }
      }
    },
    write(domain, id, name, value) {
      const definition = recipeField(domain, name), entry = row(domain, id);
      if (!entry || !validRecipeValue(definition.type, value)) throw new Error(`Invalid editable value: ${domain}.${name}`);
      entry.values[name] = snapshotDraft(value);
      if (!entry.touched.includes(name)) entry.touched.push(name);
    },
    dirty() {
      for (const [domain, entries] of groups) for (const [id, entry] of entries) for (const name of Object.keys(RECIPE_FIELDS[domain])) {
        if (!sameDraft(entry.values[name], entry.baseline[name])) return true;
      }
      return false;
    },
  };
}
