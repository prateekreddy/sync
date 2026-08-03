/**
 * Escaping for the HTML the gateway writes into Plane.
 *
 * Plane's descriptions and comments are rich text, and almost everything the
 * gateway puts in them is someone else's words — a capture body, a work item
 * title, an agent name, a retraction reason. Three files had grown their own
 * identical copy of this, which is how one of them ends up fixed and the others
 * do not.
 *
 * Ampersand first: escaping `<` before `&` would turn a literal `&lt;` in the
 * source text into `&amp;lt;`, and doing it the other way round double-escapes
 * every entity this function itself produces.
 */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
