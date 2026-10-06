export const messages: Record<string, string>;
export function humanError(error: unknown, interfaces?: { parseError: (data: any) => { name: string } | null }[]): string;
