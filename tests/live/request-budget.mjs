export function createRequestBudget(limit = 20) {
  let requests = 0;
  return {
    get requests() { return requests; },
    wrap(onPayload) {
      return async (payload, model) => {
        if (requests >= limit) throw new Error("Live request budget exceeded");
        requests++;
        return await onPayload?.(payload, model);
      };
    },
  };
}
