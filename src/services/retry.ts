export async function withRetry<T>(
  action: () => Promise<T>,
  options: { retries: number; delayMs: number }
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await action();
    } catch (error) {
      attempt += 1;
      if (attempt > options.retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
  }
}
