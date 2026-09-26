import { useState } from "react";

/**
 * The value, or the last non-null one it had. A dialog keeps showing the
 * record it was opened for while it animates closed, instead of "undefined".
 */
export function useLast<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  if (value !== null && value !== last) setLast(value);
  return value ?? last;
}
