/**
 * T3 (THROUGHPUT-SPRINT): batch-file parsing for `pair ask/send -Batch`.
 * A batch file is markdown split on `## ` headings — one item per heading,
 * heading line included in the item body (it is the item's title). Text
 * before the first heading must be blank: silently dropping preamble would
 * lose content the sender wrote.
 */
export function splitBatchItems(raw: string): string[] {
  const sections = raw.split(/^(?=## )/m);
  if (sections.length > 0 && !sections[0]!.startsWith('## ')) {
    const preamble = sections.shift()!;
    if (preamble.trim() !== '') {
      throw new Error('Batch file has content before the first "## " heading — every item must live under a heading (2..16 of them).');
    }
  }
  const items = sections.map((s) => s.trim()).filter((s) => s !== '');
  if (items.length < 2) {
    throw new Error(`A batch file needs at least two "## " item headings (found ${items.length}); for one item use plain pair ask/send.`);
  }
  return items;
}
