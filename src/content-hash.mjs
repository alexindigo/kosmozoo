// Browser-safe content identity grammar; hashing bytes remains engine-owned.
export const isContentHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
