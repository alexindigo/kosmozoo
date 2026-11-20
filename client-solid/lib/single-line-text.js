// Presentation only. Never use the result as an address, key or request value.
export const singleLineText = value => String(value ?? "").replace(/[\r\n\t\u2028\u2029]/g, " ");
