/** A plain check that a value looks like one email address (name@domain.tld). */
export function isEmail(value: string): boolean {
  return /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/.test(value.trim())
}

/** Several addresses typed in one box, split on commas / semicolons / spaces; lower case, no repeats. */
export function parseEmailList(value: string): { ok: string[]; bad: string[] } {
  const parts = value.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean)
  const ok = [...new Set(parts.filter(isEmail))]
  const bad = parts.filter((x) => !isEmail(x))
  return { ok, bad }
}
