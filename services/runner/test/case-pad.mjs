// A planted case stays small on disk (a case file over the diff size cap would make its own PR unreviewable): a changed
// file may give `padTo` instead of its full text, and the text is padded with spaces to exactly that many characters.
// Two files with the same text and `padTo` are byte-identical, as the app starter's two lockfile copies are.
export const padFile = ({ padTo, ...f }) => (padTo === undefined ? f : { ...f, text: (f.text + " ".repeat(padTo)).slice(0, padTo) });
export const padCase = (c) => (c.files ? { ...c, files: c.files.map(padFile) } : c);
