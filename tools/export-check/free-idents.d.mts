/** Free (undeclared, non-host-global) identifiers of one JS source, sorted. */
export function freeIdentifiers(code: string): string[];
/** As `freeIdentifiers`, each as `name@line` of its first reference. */
export function freeIdentifiersWithLines(code: string): string[];
