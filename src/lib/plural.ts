/** "1 product", "2 products". Counts are formatted en-IN. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? one : many}`;
}

/** Fix "1 products"-style slips in filled message text. */
export function fixCountPlurals(text: string): string {
  return text.replace(/\b1 (product|page|item|source|order|message|contact)s\b/g, "1 $1");
}
