// Pure URL-state codec and predicate compiler; Store owns the live model.
export const emptyFilter = () => ({ mode: 'and', filename: '', directory: '', down: false, up: false,
  favorite: false, bookmark: false, negativeMode: 'any', negative: '', positiveMode: 'any', positive: '',
  parameter: '', parameterMode: 'present', parameterValue: '' });
const toggles = ['down', 'up', 'favorite', 'bookmark'];
const strings = ['filename', 'directory', 'negative', 'positive', 'parameter', 'parameterValue'];
export function normalizeFilter(value) {
  const input = typeof value === 'string' ? { filename: value } : value ?? {}, out = emptyFilter();
  for (const key of strings) if (typeof input[key] === 'string') out[key] = input[key];
  for (const key of toggles) out[key] = input[key] === true || input[key] === 'true';
  if (input.mode === 'or') out.mode = 'or';
  for (const sign of ['negative', 'positive']) if (['nonempty', 'contains'].includes(input[sign + 'Mode'])) out[sign + 'Mode'] = input[sign + 'Mode'];
  if (['equals', 'contains'].includes(input.parameterMode)) out.parameterMode = input.parameterMode;
  return out;
}
const keys = { filename: 'filter', mode: 'filterMode', directory: 'filterDirectory', down: 'filterDown', up: 'filterUp',
  favorite: 'filterStar', bookmark: 'filterBookmark', negativeMode: 'filterNegativeMode', negative: 'filterNegative',
  positiveMode: 'filterPositiveMode', positive: 'filterPositive', parameter: 'filterParameter',
  parameterMode: 'filterParameterMode', parameterValue: 'filterValue' };
export function parseFilter(query) {
  const input = {};
  for (const [key, url] of Object.entries(keys)) if (query.has(url)) input[key] = toggles.includes(key) ? query.get(url) === '1' : query.get(url);
  return normalizeFilter(input);
}
export function serializeFilter(value, query = new URLSearchParams()) {
  const model = normalizeFilter(value), defaults = emptyFilter();
  for (const [key, url] of Object.entries(keys)) {
    if (model[key] !== defaults[key]) query.set(url, toggles.includes(key) ? '1' : model[key]);
    else query.delete(url);
  }
  return query;
}
const contains = (value, query) => String(value ?? '').toLowerCase().includes(query.toLowerCase());
export function filterConditions(value) {
  const m = normalizeFilter(value), out = [];
  const add = (label, matches) => out.push({ label, matches });
  if (m.filename) add(`Filename contains “${m.filename}”`, entry => contains(entry.filename, m.filename));
  if (m.directory) add(`Directory contains “${m.directory}”`, entry => contains(entry.filename.slice(0, Math.max(0, entry.filename.lastIndexOf('/'))), m.directory));
  for (const [key, label] of [['down', 'Thumbs down'], ['up', 'Thumbs up'], ['favorite', 'Starred'], ['bookmark', 'Bookmarked']]) {
    if (m[key]) add(label, entry => key === 'down' || key === 'up' ? entry.judgment?.vote === key : !!entry.judgment?.[key]);
  }
  for (const sign of ['negative', 'positive']) {
    if (m[sign + 'Mode'] === 'any') continue;
    const mode = m[sign + 'Mode'];
    add(`${sign === 'negative' ? 'Negative' : 'Positive'} feedback ${mode === 'nonempty' ? 'non-empty' : `contains “${m[sign]}”`}`,
      entry => mode === 'nonempty' ? !!entry.judgment?.notes?.[sign === 'negative' ? 'neg' : 'pos']?.trim() : contains(entry.judgment?.notes?.[sign === 'negative' ? 'neg' : 'pos'], m[sign]));
  }
  if (m.parameter) {
    const split = m.parameter.lastIndexOf('.'), type = m.parameter.slice(0, split), input = m.parameter.slice(split + 1);
    add(`${m.parameter} ${m.parameterMode}${m.parameterMode === 'present' ? '' : ` “${m.parameterValue}”`}`, entry =>
      !!entry.meta && (entry.meta.nodes ?? []).some(node => node.type === type && Object.hasOwn(node.inputs ?? {}, input) &&
        (m.parameterMode === 'present' || (m.parameterMode === 'equals' ? String(node.inputs[input]) === m.parameterValue : contains(node.inputs[input], m.parameterValue)))));
  }
  return out;
}
export function compileFilter(value) {
  const model = normalizeFilter(value), conditions = filterConditions(model);
  return entry => !conditions.length || (model.mode === 'or' ? conditions.some(c => c.matches(entry)) : conditions.every(c => c.matches(entry)));
}
export function parameterNames(entries) {
  const names = new Set();
  for (const entry of entries) for (const node of entry.meta?.nodes ?? []) for (const input of Object.keys(node.inputs ?? {})) names.add(`${node.type}.${input}`);
  return [...names].sort();
}
