export const staleSource = host => `${host} was removed or changed since Variations opened. Nothing more was sent; reopen Variations to continue. Your edits are kept until you close.`;
export const sourceFailure = (status, message, host) => status === 412 && /^(Source origin changed|Source changed|Run destination changed)/.test(message)
  ? staleSource(host) : message;
